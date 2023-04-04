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
const MODEL = 'gpt-3.5-turbo';

const ERR_COMMENT_NOT_PERMITTED = DROP_PREFIX + ' ' +
    'Your current Github account is not permitted to trigger OPENAI requests.  \n' +
    'Please consult the repository owner for more info.';
const ERR_COMMENT_REQUEST_OPENAI_FAILED = DROP_PREFIX + ' ' +
    'Request OPENAI failed.';
const ERR_COMMENT_UNABLE_TO_BUILD_PROMPT = DROP_PREFIX + ' ' +
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
    core.debug(`created comment ${inspectJson(comment.data)}`);

    const id = comment.data.id;
}

function formatOpenAIMsg(msg) {
    let role = 'user';
    let name = msg.user;
    let content = msg.msg;
    if (msg.type == TYPE_ASSISTANT) {
        role = ROLE_ASSISTANT;
    } else if (msg.type == TYPE_SYSTEM) {
        role = ROLE_SYSTEM;
    }
    return {
        role: role,
        name: name,
        content: content,
    };
}

function filterMsgs(msgs, inputs) {
    let count = 0;
    for (const msg of msgs) {
        count += msg.content.length;
    }
    core.debug(`total prompt characters: ${count}`);
    if (count < inputs.promptLimit) {
        core.info(`total prompt characters ${count}`);
        return msgs;
    }

    count = 0;
    const ret = [];
    for (let msg of msgs) {
        const n = msg.content.length;
        if (count + n > inputs.promptFromBeginningMax) {
            break;
        }
        count += n;
        ret.push(msg);
    }
    core.info(`beginning prompt characters: ${count}`);

    const ending = [];
    for (let i = msgs.length - 1; i >= 0; --i) {
        const msg = msgs[i];
        const n = msg.content.length;
        if (count + n > inputs.promptLimit) {
            break;
        }
        count += n;
        ending.push(msg);
    }
    core.info(`total characters after cutting: ${count}`);

    if (ending.length > 0) {
        ret.push({
            role: ROLE_SYSTEM,
            content: SEPARATOR,
        });
    }
    for (var i = ending.length - 1; i >= 0; --i) {
        ret.push(ending[i]);
    }

    return ret;
}

async function handle(msgs, inputs) {
    core.debug(`msgs: ${inspectJson(msgs)}`);

    let openaiMsgs = msgs.map(msg => formatOpenAIMsg(msg));
    core.debug(`pre msgs: ${inspectJson(openaiMsgs)}`);
    openaiMsgs = filterMsgs(openaiMsgs, inputs);
    core.debug(`req msgs: ${inspectJson(openaiMsgs)}`);

    if (openaiMsgs.length === 0) {
        addComment(ERR_COMMENT_UNABLE_TO_BUILD_PROMPT, inputs);
        return;
    }

    let result;
    try {
        const configuration = new openai.Configuration({
            apiKey: inputs.openaiKey,
        });
        const api = new openai.OpenAIApi(configuration);
        const completion = await api.createChatCompletion({
            model: MODEL,
            messages: openaiMsgs,
        });
        core.debug(`chat completion result ${inspectJson(completion.data)}`);
        try {
            core.info(`token usage: ${inspect(completion.data.usage)}`);
        } catch (ignore) { }

        const choices = completion.data.choices;
        core.debug(`choices ${inspectJson(choices)}`);
        result = choices[0].message.content;
        if (!result) {
            throw new Error("failed to retrieve result from openai");
        }
    } catch (e) {
        try {
            addComment(ERR_COMMENT_REQUEST_OPENAI_FAILED + '\n' + inspect(e), inputs);
        } catch (ignore) { }
        throw e;
    }

    addComment(ASSISTANT_PREFIX + ' ' + result, inputs);
}

function checkPrefix(msg, prefix) {
    for (const p of prefix) {
        const fmt = '/' + p + ':';
        if (msg.startsWith(fmt)) {
            core.debug(`msg starts with ${fmt}`);
            return msg.substring(fmt.length).trim();
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

async function getIssueMessage(inputs) {
    const issue = await inputs.octokit.rest.issues.get({
        owner: inputs.repo[0],
        repo: inputs.repo[1],
        issue_number: inputs.issueNumber,
    });
    core.debug(`issue: ${inspectJson(issue.data)}`);
    let type = TYPE_PLAIN;
    let issueUser = issue.data.user.login;
    let issueContent = issue.data.body;
    if (issueContent.startsWith(SYSTEM_PREFIX)) {
        issueContent = issueContent.substring(SYSTEM_PREFIX.length).trim();
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

async function formatAllMessages(inputs) {
    const msgs = await getIssueMessage(inputs);
    let page = 1;
    const perPage = 29; // use a prime number
    while (true) {
        const comments = await inputs.octokit.rest.issues.listComments({
            owner: inputs.repo[0],
            repo: inputs.repo[1],
            issue_number: inputs.issueNumber,
            per_page: perPage,
            page: page,
        });
        core.debug(`comments ${inspectJson(comments.data)}`);
        for (const c of comments.data) {
            let user = c.user.login;
            let msg = c.body || '';
            let type = TYPE_PLAIN;
            if (msg.startsWith(ASSISTANT_PREFIX)) {
                msg = msg.substring(ASSISTANT_PREFIX.length).trim();
                type = TYPE_ASSISTANT;
                user = ROLE_ASSISTANT;
            } else if (msg.startsWith(DROP_PREFIX)) {
                continue;
            } else if (msg.startsWith(SYSTEM_PREFIX)) {
                msg = msg.substring(SYSTEM_PREFIX.length).trim();
                type = TYPE_SYSTEM;
                user = undefined;
            } else {
                const fmtMsg = checkPrefix(msg, inputs.prefix);
                if (fmtMsg) {
                    msg = fmtMsg;
                    type = TYPE_PROMPT;
                } else {
                    msg = msg.trim();
                }
            }
            if (msg === SUBMIT_ONLY_MESSAGE) {
                continue;
            }
            msgs.push({
                user: user,
                msg: msg,
                type: type,
                permission: getPermission(user, inputs),
            });
        }
        if (comments.data.length < perPage) {
            break;
        }
        ++page;
    }
    return msgs;
}

async function run() {
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
    const promptLimit = parseInt(core.getInput("prompt-input") || '3000');
    const promptFromBeginningMax = parseInt(core.getInput("prompt-from-beginning-max") || '500');
    if (isNaN(promptLimit) || promptLimit <= 0) {
        throw new Error('invalid prompt-limit: must > 0');
    }
    if (isNaN(promptFromBeginningMax) || promptFromBeginningMax < 0 || promptFromBeginningMax > promptLimit) {
        throw new Error('invalid prompt-beginning-max: must >= 0 and <= promptLimit');
    }

    const inputs = {
        token: core.getInput("token"),
        openaiKey: core.getInput("openai-key"),
        issueNumber: core.getInput("issue-number"),
        commentId: core.getInput("comment-id"),
        prefix: prefix,
        whitelist: whitelist,
        promptLimit: promptLimit,
        promptFromBeginningMax: promptFromBeginningMax,
    };
    core.debug(`Inputs: ${inspectJson(inputs)}`);
    if (!inputs.token) {
        throw new Error('missing token');
    }
    if (!inputs.issueNumber) {
        throw new Error('missing issue-number');
    }
    if (!inputs.openaiKey) {
        throw new Error('missing openai-key');
    }

    const repository = process.env.GITHUB_REPOSITORY;
    const repo = repository.split("/");
    core.debug(`repository: ${inspectJson(repo)}`);
    inputs.repo = repo;

    const octokit = github.getOctokit(inputs.token);
    inputs.octokit = octokit;

    if (inputs.commentId) {
        const comment = await octokit.rest.issues.getComment({
            owner: repo[0],
            repo: repo[1],
            comment_id: inputs.commentId,
        });
        core.debug(`comment: ${inspectJson(comment.data)}`);
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
        await handle(msgs, inputs);
    }
}

async function main() {
    try {
        await run();
    } catch (error) {
        core.debug(inspect(error));
        core.setFailed(error.message);
        if (error.message == 'Resource not accessible by integration') {
            core.error(`See this action's readme for details about this error`);
        }
    }
}

main();
