# chat-in-issue

通过Github Actions，在issue中使用OpenAI ChatGPT。

## 如何使用

### 快速启动！

如果只是想使用ChatGPT而不关心与已有仓库的集成，可以直接fork [demo仓库](https://github.com/wkgcass/demo-of-chat-in-issue/)。  
然后按照那个仓库README中记录的步骤进行配置即可。

### 在已有仓库中使用Action

在仓库中创建文件：`/.github/workflows/chat-in-issue.yaml`

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

该配置将读取Secrets中的OPENAI_KEY配置，以及Variables中的CHAT_IN_ISSUE_USER_WHITELIST配置。  
如果你的仓库是public仓库，那么则建议配置`user-whitelist`，否则该配置可以视情况省略。

## 配置项

支持如下配置项：

### ⚙️ token

Github token。默认使用`${{ github.token }}`，需要配置读写权限（默认的workflow token权限为只读）。

具体会调用的API如下：

* 读取issue
* 读取和写入issue comment
* 读取issue comment列表

### ⚙️ openai-key

_必填项_

调用Openai API所使用的密钥，一般以"sk-"开头。

推荐将该key配置在"Secrets"中。

### ⚙️ model

使用的AI模型名。默认为`gpt-3.5-turbo`。

### ⚙️ issue-number

触发事件的issue。默认使用`${{ github.event.issue.number }}`。

一般省略不写即可。

### ⚙️ comment-id

触发事件的comment。默认使用`${{ github.event.comment.id }}`，可能为空。

一般省略不写即可。

### ⚙️ prefix

Issue或评论的内容应当以这里配置的"$prefix"为开头，具体格式为"/$prefix:"。  
比方说，如果前缀配置为"chat"，那么只有以"/chat:"开头的issue或评论才会触发prompt。  
多个前缀可以用逗号分隔。  
请注意，有一些不应使用的前缀：

* `/ai-says:` 响应信息，在prompt中会被作为`role=assistant`消息
* `/err:` 错误信息，以该字符串开头的issue或评论不会作为prompt的一部分
* `/system:` 不会触发prompt，但是会被作为`role=system`消息

如果消息包含的字符串恰好为"submit"，则该消息本身将不会用作prompt的一部分。

`prefix`的默认值为`chat`。

### ⚙️ user-whitelist

用户白名单。仅白名单上的用户可以触发prompt。白名单的每一行是一个正则表达式，任何一行的正则检查通过则算作通过。  
如果不写，则使用默认值`.*`（全部允许）。

建议将白名单配置在`Variables`中。

### ⚙️ prompt-limit

该配置可与`prompt-from-beginning-max`配合使用。

Prompt最大字符数限制。

如果整个聊天上下文的总字数不超过该值，则所有内容都将作为prompt消息。  
否则将从最前面开始，取不超过`$prompt-from-beginning-max`指定的数量的字符；然后再从最后面开始，取总量不超过本配置的字符。

如果某条消息被截断，则该消息整体都会被丢弃。

默认值为`3000`。

### ⚙️ prompt-from-beginning-max

该配置可与`prompt-limit`配合使用。

从聊天上下文的最前面开始计算的最大字符数。

默认值为`500`。
