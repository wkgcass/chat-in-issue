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

Maximum character limit for prompt messages. 

If the total number of characters in the entire chat context does not exceed this value, all content will be used as prompt messages.  
Otherwise, the program will take up to `$prompt-from-tail-initial-max` characters starting from the end;  
then take up to `$prompt-from-beginning-max` characters starting from the front;  
finally, take up to `$prompt-limit` characters starting from the final position determined in the first step.

If a message is truncated, the entire message will be discarded.

The default value is `3000`.

### ⚙️ prompt-from-tail-initial-max

**Since v1.2**

This configuration can be used in conjunction with `prompt-limit`.

The maximum number of characters counted from the end of the chat context when initially read.

The default value is `0`.

### ⚙️ prompt-from-beginning-max

This configuration can be used in conjunction with `prompt-limit`.

The maximum number of characters calculated from the beginning of the chat context.

The default value is `500`.

### ⚙️ show-token-usage

**Since v1.1**

Show the usage of the OpenAI token in comments. The default value is `false`.

The usage will be displayed in a separate comment, and the comment will start with `/err:`.

### ⚙️ prompt-exclude-ai-response

**Since v1.2**

Exclude the content returned by AI in the prompt. The default value is `false`.

If this function is enabled, the program will automatically insert a system message before the last message when necessary, which is used to distinguish the last message from previous messages.

### ⚙️ trim-mode

**Since v1.2**

Defines the method of trimming the text. The default value is `normal`.

The following trim modes are supported:

1. `normal`: Treats the entire text as a string and trims the leading and trailing whitespaces of the string.
2. `none`: No trimming will be done.
3. `each-line`: Trims the leading and trailing whitespaces of each line and deletes empty lines.

## Specialized Configuration for Specific Chat Contexts (Issues)

**Since v1.2**

By configuring specific labels in the issue, you can override the global configuration in the yaml file.

The label name starts with `chat-in-issue/`, followed by the name of the configuration item, then followed by `=` and its required configuration value.

The following configuration items support overriding with labels:

* `chat-in-issue/prompt-limit={}`
* `chat-in-issue/prompt-from-tail-initial-max={}`
* `chat-in-issue/show-token-usage={}`
* `chat-in-issue/show-token-usage={}`
* `chat-in-issue/prompt-exclude-ai-response={}`
