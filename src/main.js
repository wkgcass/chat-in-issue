const { inspect } = require("util");
const inspectJson = o => JSON.stringify(o);
const core = require("@actions/core");
const github = require("@actions/github");
const openai = require("openai");

const ASSISTANT_PREFIX = '/ai-says:';
const DROP_PREFIX = '/err:';
const SYSTEM_PREFIX = '/system:';
const TYPE_PLAIN = 'plain';
const TYPE_ASSISTANT = 'assistant';
const TYPE_PROMPT = 'prompt';
const TYPE_SYSTEM = 'system';

const SUBMIT_ONLY_MESSAGE = 'submit';

const ROLE_ASSISTANT = 'assistant';
const ROLE_SYSTEM = 'system';
const DEFAULT_MODEL = 'gpt-3.5-turbo';

const ERR_COMMENT_NOT_PERMITTED = DROP_PREFIX + '\n\n' +
    'Your current Github account is not permitted to trigger OPENAI requests.  \n' +
    'Please consult the repository owner for more info.';
const ERR_COMMENT_REQUEST_OPENAI_FAILED = DROP_PREFIX + '\n\n' +
    'Request OPENAI failed.';
const ERR_COMMENT_UNABLE_TO_BUILD_PROMPT = DROP_PREFIX + '\n\n' +
    'Unable to build prompt.';

const SEPARATOR = 'The above messages are the beginning of a conversation context, ' +
    'and the below are the latest messages of this conversation context.';

async function addComment(result, inputs) {
    let n;
    while ((n = result.indexOf(inputs.openaiKey)) !== -1) {
        result = result.substring(0, n) + '**OPENAI_KEY**' + result.substring(n + inputs.openaiKey.length);
    }
    core.info(`adding comment: ${result}`);

    const comment = await inputs.octokit.rest.issues.createComment({
        owner: inputs.repo[0],
        repo: inputs.repo[1],
        issue_number: inputs.issueNumber,
        body: result,
    });
    core.debug(`comment created`);
    // core.debug(`created comment ${inspectJson(comment.data)}`);
}

function formatOpenAIMsg(msg) {
    let role = 'user';
    let name = msg.user;
    let content = msg.msg;
    if (msg.type === TYPE_ASSISTANT) {
        role = ROLE_ASSISTANT;
    } else if (msg.type === TYPE_SYSTEM) {
        role = ROLE_SYSTEM;
    }
    return {
        role: role,
        name: name,
        content: content,
    };
}

const CONTENT_PRINT_CUT_SUFFIX = '...';
function cutMsgForDebug(content, limit) {
    if (content.length > limit + CONTENT_PRINT_CUT_SUFFIX.length) {
        content = content.substring(0, limit) + CONTENT_PRINT_CUT_SUFFIX;
    }
    content = content.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    return content;
}

async function handle(msgs, inputs) {
    core.debug(`msgs: ${inspectJson(msgs)}`);

    let openaiMsgs = msgs.map(msg => formatOpenAIMsg(msg));
    core.debug(`prompt msgs: ${inspectJson(openaiMsgs)}`);

    if (openaiMsgs.length === 0) {
        await addComment(ERR_COMMENT_UNABLE_TO_BUILD_PROMPT, inputs);
        return;
    }

    core.info(`prompt messages: [`);
    const CONTENT_PRINT_LIMIT = 20;
    for (const msg of openaiMsgs) {
        const content = cutMsgForDebug(msg.content, CONTENT_PRINT_LIMIT);
        core.info(`\trole=${msg.role}\tname=${msg.name}\tlen=${msg.content.length}\tcontent=${content}`);
    }
    core.info(`]`);

    let result;
    let usage;
    try {
        const configuration = new openai.Configuration({
            apiKey: inputs.openaiKey,
        });
        const api = new openai.OpenAIApi(configuration);
        const completion = await api.createChatCompletion({
            model: inputs.model,
            messages: openaiMsgs,
        });
        // core.debug(`chat completion result ${inspectJson(completion.data)}`);
        usage = completion.data.usage;
        try {
            core.info(`token usage: ${inspect(usage)}`);
        } catch (ignore) { }

        const choices = completion.data.choices;
        core.debug(`choices ${inspectJson(choices)}`);
        result = choices[0].message.content;
        if (!result) {
            throw new Error("failed to retrieve result from openai");
        }
    } catch (e) {
        try {
            await addComment(ERR_COMMENT_REQUEST_OPENAI_FAILED + '\n```\n' + inspect(e) + '\n```\n', inputs);
        } catch (ignore) { }
        throw e;
    }

    await addComment(ASSISTANT_PREFIX + '\n\n' + result, inputs);
    if (inputs.showTokenUsage) {
        try {
            await addComment(DROP_PREFIX + ' token usage: ' + JSON.stringify(usage), inputs);
        } catch (e) {
            core.error(`failed to add comment for token usage: ${inspect(e)}`);
        }
    }
}

function trim(s) {
    return s.split('\n').map(line => line.trim()).filter(line => !!line).join('\n');
}

// return null if no prefix matches
function checkPrefix(msg, prefix) {
    for (const p of prefix) {
        const fmt = '/' + p + ':';
        if (msg.startsWith(fmt)) {
            core.debug(`msg starts with ${fmt}`);
            return trim(msg.substring(fmt.length));
        }
    }
    return null;
}

function getPermission(user, inputs) {
    for (const w of inputs.whitelist) {
        if (w.test(user)) {
            return { permitted: true };
        }
    }
    return { permitted: false };
}

async function getIssue(inputs) {
    const issue = await inputs.octokit.rest.issues.get({
        owner: inputs.repo[0],
        repo: inputs.repo[1],
        issue_number: inputs.issueNumber,
    });
    // core.debug(`issue: ${inspectJson(issue.data)}`);
    return issue;
}

async function listComments(inputs, page, perPage) {
    const comments = await inputs.octokit.rest.issues.listComments({
        owner: inputs.repo[0],
        repo: inputs.repo[1],
        issue_number: inputs.issueNumber,
        per_page: perPage,
        page: page,
    });
    // core.debug(`comments: ${inspectJson(comments.data)}`);
    return comments;
}

function extractMessageFromIssue(issue, inputs) {
    let type = TYPE_PLAIN;
    let issueUser = issue.data.user.login;
    let issueContent = issue.data.body;
    if (issueContent.startsWith(SYSTEM_PREFIX)) {
        issueContent = trim(issueContent.substring(SYSTEM_PREFIX.length));
        type = TYPE_SYSTEM;
        issueUser = undefined;
    } else {
        const fmtContent = checkPrefix(issueContent, inputs.prefix);
        if (fmtContent) {
            issueContent = fmtContent;
            type = TYPE_PROMPT;
        }
    }
    return [{
        user: issueUser,
        msg: issueContent,
        type: type,
        permission: getPermission(issueUser, inputs),
    }];
}

async function getIssueMessage(inputs) {
    const issue = await getIssue(inputs);
    return extractMessageFromIssue(issue, inputs);
}

function handleComment(c, inputs) {
    let user = c.user.login;
    let msg = c.body || '';
    let type = TYPE_PLAIN;
    if (msg.startsWith(ASSISTANT_PREFIX)) {
        msg = trim(msg.substring(ASSISTANT_PREFIX.length));
        type = TYPE_ASSISTANT;
        user = ROLE_ASSISTANT;
    } else if (msg.startsWith(DROP_PREFIX)) {
        return;
    } else if (msg.startsWith(SYSTEM_PREFIX)) {
        msg = trim(msg.substring(SYSTEM_PREFIX.length));
        type = TYPE_SYSTEM;
        user = undefined;
    } else {
        const fmtMsg = checkPrefix(msg, inputs.prefix);
        if (fmtMsg) {
            msg = fmtMsg;
            type = TYPE_PROMPT;
        } else {
            msg = trim(msg);
        }
    }
    if (msg === SUBMIT_ONLY_MESSAGE) {
        return;
    }
    return {
        user: user,
        msg: msg,
        type: type,
        permission: getPermission(user, inputs),
    };
}

// step 1: read msgs from tail with limit promptFromTailInitialMax
// step 2: read msgs from the beginning with limit promptFromBeginningMax
// step 3: read msgs from cursor of step 1 with total limit promptLimit
// and all msgs length should < promptLimit
async function formatAllMessages(inputs) {
    const issue = await getIssue(inputs);
    let msgs = extractMessageFromIssue(issue, inputs);
    const commentSize = issue.data.comments;
    core.debug(`commentSize: ${commentSize}`);

    // cursors represent the comment already handled
    let cursorFromTail = commentSize + 1;
    let cursorFromBeginning = -1; // 0 means issue body

    let total = 0;

    const tailMsgs = [];

    if (inputs.promptFromTailInitialMax > 0) {
        core.debug(`step 1: fetch messages from tail with limit ${inputs.promptFromTailInitialMax}`);

        const perPage = 11; // use a prime number
        let page = parseInt(commentSize / perPage) + ((commentSize % perPage) === 0 ? 0 : 1); // last page
        let handledMessages = 0;

        loop:
        while (true) {
            if (page <= 0) {
                break;
            }
            const comments = await listComments(inputs, page, perPage);
            for (let i = comments.data.length - 1; i >= 0; --i) {
                const c = comments.data[i];
                const msg = handleComment(c, inputs);
                if (!msg) {
                    core.debug(`comment ${c.id}/${cursorFromTail - 1} skipped`);
                    --cursorFromTail;
                    ++handledMessages;
                    continue;
                }
                const len = msg.msg.length;
                core.debug(`comment = ${c.id}/${cursorFromTail - 1}, len = ${len}, total (before adding) = ${total}`);
                if (total + len > inputs.promptFromTailInitialMax) {
                    core.debug(`comment ${c.id}/${cursorFromTail - 1} cannot be added, will exceed promptFromTailInitialMax, ${total} + ${len} > ${inputs.promptFromTailInitialMax}`);
                    break loop;
                }
                ++handledMessages;
                --cursorFromTail;
                total += len;
                tailMsgs.push(msg);
            }
            --page;
        }
        core.debug(`step 1: handled messages ${handledMessages}, total = ${total}, cursorFromBeginning = ${cursorFromBeginning}, cursorFromTail = ${cursorFromTail}`);
        if (tailMsgs.length) {
            const msg = cutMsgForDebug(tailMsgs[tailMsgs.length - 1].msg, 100);
            core.debug(`step 1: last handled message: ${msg}`);
        }
    } else {
        core.debug(`step 1: skipped`);
    }

    // check whether need to return after step 1
    core.debug(`issue-body = ${msgs[0].msg.length}, total = ${total}, cursorFromTail = ${cursorFromTail}`);
    if (msgs[0].msg.length + total > inputs.promptLimit) {
        core.debug(`cannot hold issue body, remove it and return`);
        msgs = [];
        for (let i = tailMsgs.length - 1; i >= 0; --i) {
            msgs.push(tailMsgs[i]);
        }
        return msgs;
    }
    if (cursorFromTail === 1) {
        core.debug(`all comments handled`);
        if (msgs[0].msg.length > inputs.promptFromBeginningMax) {
            core.debug(`the issue body len ${msgs[0].msg.length} exceeds promptFromBeginningMax ${inputs.promptFromBeginningMax}`);
            msgs = [];
        } else {
            core.debug(`the issue body is preserved`);
        }
        // no need to add separator
        core.debug(`all comments fetched in step 1`);
        for (let i = tailMsgs.length - 1; i >= 0; --i) {
            msgs.push(tailMsgs[i]);
        }
        return msgs;
    }

    if (msgs[0].msg.length > inputs.promptFromBeginningMax) {
        core.debug(`skip step 2: issue body ${msgs[0].msg.length} exceeds ${inputs.promptFromBeginningMax}`);
        msgs = [];
    } else {
        core.debug(`step 2: trying to get messages from the beginning with limit ${inputs.promptFromBeginningMax}`);

        total += msgs[0].msg.length; // count the issue body into total
        let beginning = msgs[0].msg.length;
        ++cursorFromBeginning; // issue body handled
        let handledMessages = 1;

        let page = 1;
        const perPage = 11; // use a prime number

        loop:
        while (true) {
            const comments = await listComments(inputs, page, perPage);
            if (comments.data.length === 0) { // loop done
                break;
            }
            for (const c of comments.data) {
                if (cursorFromBeginning + 1 === cursorFromTail) { // reaches
                    break loop;
                }
                const msg = handleComment(c, inputs);
                if (!msg) {
                    core.debug(`comment ${c.id}/${cursorFromBeginning + 1} skipped`);
                    ++cursorFromBeginning;
                    ++handledMessages;
                    continue;
                }
                const len = msg.msg.length;
                core.debug(`comment = ${c.id}/${cursorFromBeginning + 1}, len = ${len}, beginning (before adding) = ${beginning}, total = ${total}`);
                if (beginning + len > inputs.promptFromBeginningMax) {
                    core.debug(`comment ${c.id}/${cursorFromBeginning + 1} cannot be added, will exceed promptFromBeginningMax, ${beginning} + ${len} > ${inputs.promptFromBeginningMax}`);
                    break loop;
                }
                if (total + len > inputs.promptLimit) {
                    core.debug(`comment ${c.id}/${cursorFromBeginning + 1} cannot be added, will exceed promptLimit, ${total} + ${len} > ${inputs.promptLimit}`);
                    break loop;
                }
                ++handledMessages;
                ++cursorFromBeginning;
                beginning += len;
                total += len;
                msgs.push(msg);
            }
            ++page;
        }
        core.debug(`step 2: handled messages ${handledMessages}, total = ${total} beginning = ${beginning}, cursorFromBeginning = ${cursorFromBeginning}, cursorFromTail = ${cursorFromTail}`);
        if (msgs.length) {
            const msg = cutMsgForDebug(msgs[msgs.length - 1].msg, 100);
            core.debug(`step 2: last handled message: ${msg}`);
        }

        if (cursorFromBeginning + 1 === cursorFromTail) {
            core.debug(`step 2 cursor reaches step 1 cursor`);
            for (let i = tailMsgs.length - 1; i >= 0; --i) {
                msgs.push(tailMsgs[i]);
            }
            return msgs;
        }
    }

    core.debug(`before step 3: total = ${total}, cursorFromBeginning = ${cursorFromBeginning}, cursorFromTail = ${cursorFromTail}`);

    {
        const perPage = 29; // use a prime number
        let page = parseInt((cursorFromTail - 1) / perPage) + (((cursorFromTail - 1) % perPage === 0) ? 0 : 1);
        let handledMessages = 0;

        core.debug(`step 3: trying to get messages from the tail with limit ${inputs.promptLimit}, cursorFromTail=${cursorFromTail}`);

        let isFirstLoop = true;
        loop:
        while (true) {
            if (page <= 0) {
                break;
            }
            const comments = await listComments(inputs, page, perPage);
            const initIndex = isFirstLoop ? (cursorFromTail - 1 - (page - 1) * perPage - 1) : (comments.data.length - 1);
            if (isFirstLoop) {
                core.debug(`step 3 initIndex = ${initIndex}`);
            }
            isFirstLoop = false;

            for (let i = initIndex; i >= 0; --i) {
                if (cursorFromBeginning + 1 === cursorFromTail) { // reaches
                    break loop;
                }
                const c = comments.data[i];
                const msg = handleComment(c, inputs);
                if (!msg) {
                    core.debug(`comment ${c.id}/${cursorFromTail - 1} skipped`);
                    --cursorFromTail;
                    ++handledMessages;
                    continue;
                }
                const len = msg.msg.length;
                core.debug(`comment = ${c.id}/${cursorFromTail - 1}, len = ${len}, total (before adding) = ${total}`);
                if (total + len > inputs.promptLimit) {
                    core.debug(`comment ${c.id}/${cursorFromTail - 1} cannot be added, will exceed promptLimit, ${total} + ${len} > ${inputs.promptLimit}`);
                    break loop;
                }
                ++handledMessages;
                --cursorFromTail;
                total += len;
                tailMsgs.push(msg);
            }
            --page;
        }
        core.debug(`step 3: handled messages ${handledMessages}, total = ${total}, cursorFromBeginning = ${cursorFromBeginning}, cursorFromTail = ${cursorFromTail}`);
        if (msgs.length) {
            const msg = cutMsgForDebug(tailMsgs[tailMsgs.length - 1].msg, 100);
            core.debug(`step 3: last handled message: ${msg}`);
        }

        if (cursorFromBeginning + 1 === cursorFromTail) {
            core.debug(`no separator`);
        } else {
            core.debug(`need separator`);
            msgs.push({
                type: TYPE_SYSTEM,
                msg: SEPARATOR,
            });
        }
        for (let i = tailMsgs.length - 1; i >= 0; --i) {
            msgs.push(tailMsgs[i]);
        }
    }

    return msgs;
}

async function run() {
    const token = core.getInput("token");
    core.debug(`token: ${token}`);
    if (!token) {
        throw new Error('missing token');
    }

    const repository = process.env.GITHUB_REPOSITORY;
    const repo = repository.split("/");
    core.debug(`repository: ${inspectJson(repo)}`);

    const issueNumber = core.getInput("issue-number");
    if (!issueNumber) {
        throw new Error('missing issue-number');
    }

    const octokit = github.getOctokit(token);

    const inputs = {
        token: token,
        issueNumber: issueNumber,
        repo: repo,
        octokit: octokit,
    };

    const issue = await getIssue(inputs);

    let promptLimit = parseInt(core.getInput("prompt-limit") || '3000');
    let promptFromBeginningMax = parseInt(core.getInput("prompt-from-beginning-max") || '500');
    let promptFromTailInitialMax = parseInt(core.getInput("prompt-from-tail-initial-max") || '0');
    let showTokenUsageStr = core.getInput("show-token-usage") || 'false';

    for (const label of issue.data.labels) {
        let name = label.name;
        if (name.startsWith('chat-in-issue/')) {
            name = name.substring('chat-in-issue/'.length);
        } else {
            core.debug(`skipping non chat-in-issue labels`);
            continue;
        }
        core.debug(`read chat-in-issue tag: ${name}`);
        const idx = name.indexOf('=');
        const key = name.substring(0, idx).trim();
        const value = name.substring(idx + '='.length).trim();
        if (key === 'prompt-limit') {
            promptLimit = parseInt(value);
        } else if (key === 'prompt-from-beginning-max') {
            promptFromBeginningMax = parseInt(value);
        } else if (key === 'prompt-from-tail-initial-max') {
            promptFromTailInitialMax = parseInt(value);
        } else if (key === 'show-token-usage') {
            showTokenUsageStr = value;
        } else {
            core.debug(`unknown key ${key}`);
            continue;
        }
        core.info(`overriding chat-in-issue option from labels ${key}=${value}`);
    }

    const prefixStr = core.getInput("prefix") || 'chat';
    let prefix = prefixStr.split(',').map(s => s.trim()).filter(s => !!s);
    if (prefix.length === 0) {
        prefix = ['chat'];
    }

    const whitelistStr = core.getInput("user-whitelist") || '.*';
    const whitelistStrArray = whitelistStr.split('\n').map(s => s.trim()).filter(s => !!s);
    let whitelist = whitelistStrArray.map(s => new RegExp(s));
    if (whitelist.length === 0) {
        whitelist = [/.*/];
    }

    if (isNaN(promptLimit) || promptLimit <= 0) {
        throw new Error('invalid prompt-limit: must > 0');
    }
    if (isNaN(promptFromBeginningMax) || promptFromBeginningMax < 0 || promptFromBeginningMax > promptLimit) {
        throw new Error('invalid prompt-from-beginning-max: must >= 0 and <= promptLimit');
    }
    if (isNaN(promptFromTailInitialMax) || promptFromTailInitialMax < 0 || promptFromTailInitialMax > promptLimit) {
        throw new Error('invalid prompt-from-tail-initial-max: must >= 0 and <= promptLimit');
    }

    if (showTokenUsageStr !== 'true' && showTokenUsageStr !== 'false') {
        throw new Error('invalid show-token-usage, must be "true" or "false"');
    }

    const __inputs = {
        openaiKey: core.getInput("openai-key"),
        model: core.getInput("model") || DEFAULT_MODEL,
        commentId: core.getInput("comment-id"),
        prefix: prefix,
        whitelist: whitelist,
        promptLimit: promptLimit,
        promptFromBeginningMax: promptFromBeginningMax,
        promptFromTailInitialMax: promptFromTailInitialMax,
        showTokenUsage: showTokenUsageStr === 'true',
    };
    for (const k in __inputs) inputs[k] = __inputs[k];
    core.info(`inputs = ${inspectJson(inputs)}`);
    if (!inputs.openaiKey) {
        throw new Error('missing openai-key');
    }

    if (inputs.commentId) {
        const comment = await octokit.rest.issues.getComment({
            owner: repo[0],
            repo: repo[1],
            comment_id: inputs.commentId,
        });
        // core.debug(`comment: ${inspectJson(comment.data)}`);
        const body = comment.data.body || '';
        const prefixCheck = checkPrefix(body, inputs.prefix);
        if (!prefixCheck) {
            core.debug(`should not handle this msg`);
            core.info(`this message will not be handled`);
            return;
        }

        const user = comment.data.user.login;
        const permission = getPermission(user, inputs);
        if (!permission.permitted) {
            core.debug(`not permitted: ${inspectJson(permission)}`);
            core.info(`not permitted`);
            await addComment(ERR_COMMENT_NOT_PERMITTED, inputs);
            return;
        }
        const allMessages = await formatAllMessages(inputs);
        await handle(allMessages, inputs);
    } else {
        const msgs = await getIssueMessage(inputs);
        if (msgs[0].type !== TYPE_PROMPT) {
            core.debug(`should not handle this msg: ${msgs[0].type}`);
            core.info(`this message will not be handled`);
            return;
        }
        if (!msgs[0].permission.permitted) {
            core.debug(`not permitted: ${inspectJson(msgs[0].permission)}`);
            core.info(`not permitted`);
            await addComment(ERR_COMMENT_NOT_PERMITTED, inputs);
            return;
        }
        if (msgs[0].msg.length > inputs.promptLimit) {
            core.info(`message too long`);
            await addComment(ERR_COMMENT_UNABLE_TO_BUILD_PROMPT, inputs);
            return;
        }
        await handle(msgs, inputs);
    }
}

async function main() {
    try {
        await run();
    } catch (error) {
        core.error(inspect(error));
        core.setFailed(error.message);
        if (error.message === 'Resource not accessible by integration') {
            core.error(`See this action's readme for details about this error`);
        }
    }
}

main();
