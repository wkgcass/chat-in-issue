# chat-in-issue

Use OpenAI ChatGPT in Github issues with Github Actions.

Note: This markdown file is directly translated from Chinese version markdown file by ChatGPT, see [this issue](https://github.com/wkgcass/demo-of-chat-in-issue/issues/3).

[中文文档看这里](https://github.com/wkgcass/chat-in-issue/blob/master/README_ZH.md)

## How to Use

### Quick Start!

If you just want to use ChatGPT and don't care about integrating it with an existing repository, you can simply fork the [demo repository](https://github.com/wkgcass/demo-of-chat-in-issue/).  
Then follow the steps described in that repository's README to configure it.

### Use with an Existing Repository and GitHub Actions

Create the `/github/workflows/chat-in-issue.yaml` file in your repository with the following contents:

```yaml
name: chat-in-issue
run-name: '[chat-in-issue][${{ github.workflow }}] - ${{ github.event.issue.title }}'
on:
  issues:
    types: ['opened']
  issue_comment:
    types: ['created']
jobs:
  chat-in-issue:
    if: ${{ !github.event.issue.pull_request }}
    runs-on: ubuntu-latest
    steps:
      - uses: wkgcass/chat-in-issue@v1
        with:
          openai-key: ${{ secrets.OPENAI_KEY }}
          user-whitelist: ${{ vars.CHAT_IN_ISSUE_USER_WHITELIST }}
```

This configuration reads the `OPENAI_KEY` configuration from your repository's Secrets and the `CHAT_IN_ISSUE_USER_WHITELIST` from your repository's Variables.  
If your repository is a public repository, it is recommended to configure `user-whitelist`. Otherwise, this configuration can be omitted depending on the situation.

## Configuration

The following configurations are available:

### ⚙️ token

The Github token. By default, `${{ github.token }}` is used and requires read and write permissions (the default workflow token permission is read-only).

The following APIs will be called:

* Read issue
* Read and write issue comments
* Read issue comment list

### ⚙️ openai-key

_Required_

The key used to call the OpenAI API, generally prefixed with "sk-".

It is recommended to configure this key in "Secrets".

### ⚙️ model

The name of the AI model being used. Default is `gpt-3.5-turbo`.

### ⚙️ issue-number

The issue which triggered the event. By default, `${{ github.event.issue.number }}` is used.

Generally, it can be omitted.

### ⚙️ comment-id

The comment which triggered the event. By default, `${{ github.event.comment.id }}` is used and may be empty.

Generally, it can be omitted.

### ⚙️ prefix

The content of the Issue or comment should start with "$prefix" configured here, in the format of "/$prefix:".  
For example, if the prefix configuration is "chat", only issues or comments starting with "/chat:" will trigger the prompt.  
Multiple prefixes can be separated by commas.  
Please note that there are some prefixes that should not be used:

* `/ai-says:` Response information, in the prompt will be treated as `role=assistant` message
* `/err:` Error information, issues or comments starting with this string will not be part of the prompt
* `/system:` Will not trigger the prompt, but will be treated as `role=system` message

If the message contains the string "submit", the message itself will not be used as part of the prompt.

The default value of `prefix` is `chat`.

### ⚙️ user-whitelist

User whitelist. Only users on the whitelist can trigger the prompt. Each line of the whitelist is a regular expression, and if any line's regular check passes, it counts as passed.  
If not written, the default value `.*` (allow everything) will be used.

It is recommended to configure the whitelist in `Variables`.

### ⚙️ prompt-limit

This configuration can be used in conjunction with `prompt-from-beginning-max`.

The maximum number of characters allowed in a Prompt.

If the total number of characters in the entire chat context does not exceed this value, all content will be used as prompt messages.  
Otherwise, the prompt will be taken from the start, with a maximum of `$prompt-from-beginning-max` characters; then, starting from the end, a maximum of the number of characters specified in this configuration will be taken. 

If a message is truncated, the entire message will be discarded.

The default value is `3000`.

### ⚙️ prompt-from-beginning-max

This configuration can be used in conjunction with `prompt-limit`.

The maximum number of characters calculated from the beginning of the chat context.

The default value is `500`.

### ⚙️ show-token-usage

**Since v1.1**

Show the usage of the OpenAI token in comments. The default value is `false`.

The usage will be displayed in a separate comment, and the comment will start with `/err:`.
