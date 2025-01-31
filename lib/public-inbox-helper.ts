import { createHash } from "crypto";
import { git, revParse } from "./git";
import { GitNotes } from "./git-notes";
import { GitHubGlue } from "./github-glue";
import { IMailMetadata } from "./mail-metadata";
import { IParsedMBox, parseMBox,
    parseMBoxMessageIDAndReferences } from "./send-mail";

const stateKey = "git@vger.kernel.org <-> GitGitGadget";
const replyToThisURL =
    "https://github.com/gitgitgadget/gitgitgadget/wiki/ReplyToThis";

export interface IGitMailingListMirrorState {
    latestRevision?: string;
}

export class PublicInboxGitHelper {
    public static async get(gggNotes: GitNotes, publicInboxGitDir: string,
                            githubGlue: GitHubGlue):
        Promise<PublicInboxGitHelper> {
        const state: IGitMailingListMirrorState =
            await gggNotes.get<IGitMailingListMirrorState>(stateKey) || {};
        return new PublicInboxGitHelper(gggNotes, publicInboxGitDir, githubGlue,
                                        state);
    }

    /**
     * Returns the object name Git would generate if the key (plus a trailing
     * newline) were fed to `git hash-object`.
     *
     * @param key the content to hash (a newline is automatically appended)
     * @returns the object name
     */
    public static hashKey(key: string): string {
        const hash = createHash("sha1", { encoding: "utf8" });
        hash.update(`blob ${Buffer.byteLength(key) + 1}`);
        hash.update(`\0${key}\n`);
        return hash.digest("hex");
    }

    public static mbox2markdown(mbox: IParsedMBox): string {
        let body = mbox.body;

        for (const header of mbox.headers!) {
            if (header.key === "Content-Transfer-Encoding") {
                const value = header.value.toLowerCase();
                if (value === "base64") {
                    body = Buffer.from(body, "base64").toString();
                } else if (value === "quoted-printable") {
                    const stringFromCharCode = String.fromCharCode;
                    body = body.replace(/[\t\x20]$/gm, "")
                        .replace(/=(?:\r\n?|\n|$)/g, "")
                        .replace(/=([a-fA-F0-9]{2})/g, (_$0, $1) => {
                            const codePoint = parseInt($1, 16);
                            return stringFromCharCode(codePoint);
                    });
                }
            }
        }

        if (!body.length) {
            return "";
        }

        return "``````````\n" +
            body + (body.endsWith("\n") ? "" : "\n") +
            "``````````\n";
    }

    protected readonly state: IGitMailingListMirrorState;
    protected readonly gggNotes: GitNotes;
    protected readonly publicInboxGitDir: string;
    protected readonly githubGlue: GitHubGlue;

    protected constructor(gggNotes: GitNotes, publicInboxGitDir: string,
                          githubGlue: GitHubGlue,
                          state: IGitMailingListMirrorState) {
        this.gggNotes = gggNotes;
        this.publicInboxGitDir = publicInboxGitDir;
        this.githubGlue = githubGlue;
        this.state = state;
    }

    public async processMails(prFilter?: (pullRequestURL: string) => boolean):
        Promise<boolean> {
        const keys: Set<string> = new Set<string>();
        (await git(["ls-tree", "-r", `${this.gggNotes.notesRef}:`],
                   { workDir: this.gggNotes.workDir })).split("\n")
                .map((line: string) => {
                    keys.add(line.substr(53).replace(/\//g, ""));
                });
        const seen = (messageID: string) => {
            return keys.has(PublicInboxGitHelper.hashKey(messageID));
        };

        const mboxHandler = async (messageID: string, references: string[],
                                   mbox: string) => {
                if (seen(messageID)) {
                    return;
                }
                let pullRequestURL: string | undefined;
                let originalCommit: string | undefined;
                let issueCommentId: number | undefined;
                for (const reference of references.filter(seen)) {
                    const data =
                        await this.gggNotes.get<IMailMetadata>(reference);
                    if (data && data.pullRequestURL) {
                        if (prFilter && !prFilter(data.pullRequestURL)) {
                            continue;
                        }
                        /* Cover letters were recorded with their tip commits */
                        const commit = reference.match(/^pull/) ?
                            undefined : data.originalCommit;
                        if (!pullRequestURL ||
                            (!originalCommit && commit) ||
                            (!issueCommentId && data.issueCommentId)) {
                            pullRequestURL = data.pullRequestURL;
                            issueCommentId = data.issueCommentId;
                            originalCommit = commit;
                        }
                    }
                }
                if (!pullRequestURL) {
                    return;
                }
                console.log(`Message-ID ${messageID} (length ${mbox.length
                            }) for PR ${pullRequestURL
                            }, commit ${originalCommit
                            }, comment ID: ${issueCommentId}`);

                const parsed = await parseMBox(mbox);
                const pigURL = `https://public-inbox.org/git/${messageID}`;
                const header = `[On the Git mailing list](${pigURL}), ` +
                    (parsed.from ?
                     parsed.from.replace(/ *<.*>/, "") : "Somebody") +
                     ` wrote ([reply to this](${replyToThisURL})):\n\n`;
                const comment = header +
                    PublicInboxGitHelper.mbox2markdown(parsed);

                if (issueCommentId) {
                    const result =  await this.githubGlue
                        .addPRCommentReply(pullRequestURL, issueCommentId,
                                           comment);
                    issueCommentId = result.id;
                } else if (originalCommit) {
                    const result = await this.githubGlue
                        .addPRCommitComment(pullRequestURL, originalCommit,
                                            this.gggNotes.workDir, comment);
                    issueCommentId = result.id;
                } else {
                    /*
                     * We will not use the ID of this comment, as it is an
                     * issue comment, really, not a Pull Request comment.
                     */
                    await this.githubGlue
                        .addPRComment(pullRequestURL, comment);
                }

                await this.gggNotes.set(messageID, {
                    issueCommentId,
                    messageID,
                    originalCommit,
                    pullRequestURL,
                } as IMailMetadata);

                /* It is now known */
                keys.add(PublicInboxGitHelper.hashKey(messageID));
            };

        let buffer = "";
        let counter = 0;
        const lineHandler = async (line: string): Promise<void> => {
            if (line.startsWith("@@ ")) {
                const match = line.match(/^@@ -(\d+,)?\d+ \+(\d+,)?(\d+)?/);
                if (match) {
                    counter = parseInt(match[3], 10);
                    buffer = "";
                }
            } else if (counter) {
                buffer += line.substr(1) + "\n";
                if (--counter) {
                    return;
                }
                try {
                    const parsed =
                        await parseMBoxMessageIDAndReferences(buffer);
                    await mboxHandler(parsed.messageID, parsed.references,
                                      buffer);
                } catch (reason) {
                    console.log(`${reason}: skipping`);
                }
            }
        };

        if (!this.state.latestRevision) {
            /*
             * This is the commit in public-inbox/git that is *just* before the
             * first ever GitGitGadget mail sent to the Git mailing list.
             */
            this.state.latestRevision =
                "cf3590b3a1ce08a52b01142307b8fcc089acb6a6";
        }
        const head = await revParse("master", this.publicInboxGitDir);
        if (this.state.latestRevision === head) {
            return false;
        }

        const range = `${this.state.latestRevision}..${head}`;
        await git(["log", "-p", "--reverse", range],
                  { lineHandler, workDir: this.publicInboxGitDir });

        this.state.latestRevision = head;
        await this.gggNotes.set(stateKey, this.state, true);

        return true;
    }
}
