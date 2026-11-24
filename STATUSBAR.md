# 底部状态栏扩展 API

`dsh-semantic` 的浏览器半在 `ctx.reflect.provide('statusbar', …)` 上暴露一个扩展服务，其他 client plugin 可以通过 `ctx.get('statusbar')` 注册通道和“新建”菜单项。

## 注册通道

通道显示在底部栏右侧导航中。选中后，底部栏会轮询 `read()`，把 `text` 渲染到可选择复制的日志框，并从文本里的 `[NN%]` 解析进度条。

```js
const statusbar = ctx.get('statusbar')
const dispose = statusbar.registerChannel({
  id: 'my-task',
  title: '我的任务',
  description: '可选副标题',
  order: 100,
  async read() {
    return {
      text: '正在执行\n[35%] 编译\n[100%] 完成',
      placeholder: '输入命令，Enter 发送',
    }
  },
  async write(value) {
    // 输入框提交时调用；返回下一次 read 的快照
    return { text: `收到：${value}\n` }
  },
})
```

返回值是取消注册函数。

## 注册“新建”菜单项

```js
const dispose = ctx.get('statusbar').registerMenuItem(
  '任务/构建',
  async () => {
    // 执行 VS Code task / 自定义任务
  },
)
```

也支持对象形式：

```js
ctx.get('statusbar').registerMenuItem({
  path: '任务/构建',
  label: '构建',
  order: 10,
  run: async () => {},
})
```

`path` 用 `/` 分隔，底部栏会把它渲染成“任务 › 构建”的分组菜单。`MenuItem('folder/item1')` 形式的 helper 也可用：

```js
const { MenuItem } = ctx.get('statusbar')
ctx.get('statusbar').registerMenuItem(MenuItem('任务/构建', run))
```

## 内置终端与 LSP

- `C# LSP` 是内置通道，不支持关闭；
- 自定义 shell 终端由内置实现创建，可通过通道右侧的 `×` 结束进程；
- 未来的 VS Code task、构建任务等只需要注册 channel 和 menu item，不需要修改底部栏本身。
