# pi-recap

状态：已落地

## 为什么做

离开一会儿再回来，要立刻知道「刚才发生了什么」。这不是 compact：不压缩历史、不替换对话、不进后续模型上下文。

## 意图

一行 recap 是主产物。短 title 是副产物。是否改 Pi session name、是否同步最近一层终端复用器名称，是后面两级可选副作用。给人看的旋钮很少：`/recap` 常驻，auto 才是后台开关；打开 apply 时不覆盖手动 session name。

## 心智模型

```text
最近活动 ──出环 one-shot──► recap widget
                └─ title ──可选──► session name ──可选──► Herdr / tmux 名
```

recap 读当前分支的最近活动，一次性要一行摘要。title 只沿这条链向下流；同步模块不关心名字从哪来。

出环调用不经过主循环，因此没有主循环那套 OpenRouter / NVIDIA / Cloudflare 归因头。

## 红线

- 不是 compact：不调用 compact，不注入 LLM 历史，不删不压消息。
- recap 保持一行短句，不是整段会话总结。
- 依赖单向：title → session name → multiplexer。不把命名同步做成独立主命令。
- 出环 one-shot 不复制主循环归因头。
