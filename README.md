# dsh-biomni

[English](./README_EN.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：给每个会话一个**持久的 Python 解释器**，装载 [Biomni](https://github.com/snap-stanford/Biomni) 的生物医学工具库，并在设置页里如实报告这个解释器**实际**能做什么。

不 fork harness，不改 harness 源码。它是一个普通的 out-of-tree bundle，通过 profile 组合进去。

```sh
dsh plugin --profile web add dsh-biomni
```

---

## 它做什么

一个模型可见的工具 `run_python`，背后是**每会话一个 Python 进程**。第一次调用里 import 的包、载入的 DataFrame、拟合好的模型，在第二次调用里还在。这样 agent 可以分成若干小步搭建状态，而不是每次重发一整个脚本——这正是 Biomni 的 agent 依赖的执行模型。

工具之外还有三件事，缺一不可：

| | 是什么 | 为什么需要 |
|---|---|---|
| 系统提示词分区 | 声明解释器的存在和模块清单 | 只注册工具不够——实测模型会直接去用 bash |
| `bash` 守卫 | 拒绝 shell 里直接调用 `python` / `pip` | 提示词只能纠正**第一次**选择，任务中途模型仍会回退 |
| **skill 目录** | 每个工具模块一个 skill，带真实签名 | 218 个函数的 schema 塞不进上下文——这是 Biomni 用 `ToolRetriever` 解决的问题 |
| 环境探针 | `/biomni` 命令 + 设置页 | 「模块能 import」和「函数能调用」是两个不同的数字 |

---

## 为什么是插件，而不是移植

Biomni 的内核是三样东西，只有前两样值得复现：

| Biomni | 是什么 | 这里 |
|---|---|---|
| `run_python_repl` | 一个跨 agent 回合持久的解释器命名空间 | `run_python` 工具 |
| `biomni/tool/*.py` | 21 个模块 218 个领域函数，MIT 协议 | 在那个解释器里作为普通库复用 |
| `ToolRetriever` | 按 prompt 检索相关工具子集，因为 200+ 个 schema 塞不进上下文 | **DSH skill 目录**——见下节 |
| `<execute>` / `<solution>` 标签 | 早于可靠 function calling 的文本协议 | **不复现**——dsh 有原生工具调用 |

---

## skill：Biomni 的检索层，换成 harness 原生的形状

Biomni 造 `ToolRetriever`，是因为 200+ 个工具 schema 塞不进上下文，所以它把 schema 嵌入向量、按 prompt 选一个子集出来。

**DSH 的 skill 系统本身就是这个东西，而且形状更好。** 会话目录里每个 skill 只挂 `name` + `description`，完整 body 由模型通过 `skill` 工具**按需加载**。所以这里不需要嵌入、不需要相似度、不需要一个会选错的检索器 —— 选择由模型自己的判断做出。

本插件为**每个可导入的工具模块注册一个 skill**，内容从**当前配置的那个解释器**现场生成：

```
biomni-database            40 个函数  查询 UniProt / AlphaFold / PDB / InterPro…
biomni-pharmacology        20 个函数  药物、靶点、药代
biomni-molecular-biology   18 个函数  序列与构建体
…共 18 个
```

实测的账（Biomni 0.0.8）：

| | 成本 |
|---|---|
| 目录（**常驻**，18 条 name+description） | **≈ 1.6k tokens** |
| 单个 body（按需加载） | 0.4k – 4.4k tokens |
| 如果把 218 个函数全部内联 | ≈ 26k tokens |

body 里是 Biomni 自己的元数据渲染出来的**真实签名**：参数类型、默认值，以及每个参数的说明。这比提示词原本建议的 introspect 循环强 —— `dir()` + `inspect.signature()` 要花一次调用，而且拿不到参数说明，而参数说明才是意思所在。

### 为什么是运行时生成，而不是随包发静态 markdown

因为**一个列着「本解释器根本调不通的函数」的 skill body，正是这个项目从头到尾在防的那个失败**。

skill 目录和设置页报告共用同一份两道门分析（`python/_gates.py`），所以它们对「什么能调用」不可能给出两种说法。具体表现：

- 门 1 挡住的模块（`genomics`、`bioimaging`、`genetics`）**根本不进目录** —— 它们底下没有一个函数能跑，挂在目录里纯属浪费；这些模块和它们缺什么，在设置页里看。
- 门 2 挡住的函数**不进「可用」列表，但会在 body 末尾被点名**，连同它缺哪个包，并附一句「报告缺失的包，不要自己装，更不要重新实现」。完全藏起来反而更糟：模型会靠「调用 → 失败」重新发现这个坑，而实测的失败反应不是干净地报错，是默默手搓一个替代品。
- `python` 设置一改，目录立刻 invalidate。从另一个解释器生成的目录不是「陈旧」，是**错的**。

没装 Biomni 时就是没有 skill —— 这是一个确定的答案，不是失败。

---

**提示词里只列模块，不列函数。** 218 个函数的签名放不进请求前缀，也不该放：它们现在在 skill 里，按需加载。提示词只负责把模型指过去。

---

## 安装

### 1. 建一个装了 Biomni 的解释器

Biomni 的库要 Python 3.11+ 和约 1 GB 依赖。macOS 自带的 python3 是 3.9，装不了。

```sh
python3.11 -m venv .venv
.venv/bin/pip install -r python/requirements-biomni.txt
```

### 2. 装插件

```sh
dsh plugin --profile web add dsh-biomni
```

CLI 会读取本包的 `dsh.bundle.patch` 声明，把 `dsh-biomni` 追加进 `dsh.profile.bundles`，不需要手改 profile 文件。

从源码装：

```sh
pnpm install && pnpm build
scripts/install.sh web /abs/path/to/.venv/bin/python
```

### 3. 指向那个解释器

启动 `dsh --profile web`，打开 **设置 → Biomni**，把 Python 解释器填成 `/abs/path/to/.venv/bin/python`。改动立即生效，正在跑的解释器会被退役，下一次调用从空命名空间开始。

等价地写进 `$DSH_HOME/settings.yaml`：

```yaml
biomni:
  python: /abs/path/to/.venv/bin/python
  timeoutMs: 600000
  guardShellPython: true
```

---

## 设置页：为什么能用

**这一节是本仓库相对上一版探索最重要的进展。**

dsh 0.1.0-rc.6 的 `packages/host/apiproxy` 用一个硬编码 allowlist 过滤 `settings.describe`：

```ts
const WEB_SETTINGS_NAMESPACES = ['agent-loop', 'shell', 'locale',
  'permission', 'ui-conversation', 'ui-theme', 'web-search-deepseek']
```

注释写着「a future registration does not become remotely readable or writable by default」。没有配置字段，也没有扩展点——三方 namespace 一律解析成 `status: 'unavailable'`。任何**建立在这个 RPC 之上**的设置卡片，既读不了也写不了，只能渲染成空白。上一版的设置卡片就是这么死的。

绕过它的办法不是去改 allowlist，而是**不用那条 RPC**：

- **host 半**用 `ctx.settings.register(ns, PrefsSchema)` 在**进程内**持有 namespace（进程内没有 allowlist），再开插件自己的 `/biomni/api` 路由，路由处理器里直接调 `settings.describe()` / `settings.update()`；
- **client 半**通过 `ctx.slots.inject('settings.section', …)` 注册**整个设置分区**，读写都走上面那条路由。

写入保留 seam 的 revision 守卫，所以并发写仍然会被拒绝（409），不会互相覆盖。路由带与 `/api` 网关同款的 Host 头信任围栏（loopback 或配置过的 `trustedHosts`），浏览器同源访问天然通过。

这套机制是从 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 学来的——本插件**不依赖**它，只是借鉴了同一条路子。

> 顺带：`webServer` / `webRuntime` 刻意**没有**写进插件顶层的 `inject`。它们只承载设置页，而 headless profile 两者都没有；写进去会导致整个插件在 headless 下无法激活，把 `run_python` 一起搭进去。路由从子 fiber 挂载，所以两种部署都能用。

---

## 环境探针：importable ≠ callable

Biomni 只声明了三个依赖（pydantic、langchain、python-dotenv）。它的工具真正需要的东西全部未声明，并且藏在**两道彼此独立的门**后面：

| 门 | 机制 | 代价 | 结果 |
|---|---|---:|---|
| 1 | 模块级 import | ~276 MB | 21 个模块中 18 个可导入 |
| 2 | 函数体内的惰性 import | +796 MB | 被挡住的函数：90 → 26（共 312 个）|

**门 1 是按模块全有或全无的。** 重型 import 都在模块顶部，所以一个模块要么完整导入，要么完全导不进来，没有「只装某个函数需要的部分」这种选项。`genetics`、`genomics`、`bioimaging` 进不来，它们的依赖（torch、esm、SimpleITK、nnunet）确实巨大。

更糟的是，`biomni.tool.__init__` 会 import `biomni.utils`，所以 **`tqdm` 和 `pandas` 一次性卡住全部模块**。缺了它们，21 个模块以完全相同的方式失败，而且报错不会提到这两个名字中的任何一个。

**门 2 才是真正会让人措手不及的那个。** 一个能干净导入的模块，里面的函数照样可能在调用时抛 `ModuleNotFoundError`，因为它们在函数体里才 import。任何模块级的静态分析都发现不了这些。而且这不是长尾——单是 `scipy` 就挡住 43 个函数，`scikit-image` 18 个，`opencv` 10 个。

这个问题是这么被发现的：一个 agent 调了 `literature.query_pubmed`，它需要 `pymed`，什么也没拿到，然后**默默手搓了一个自己的 PubMed 客户端**。**importable 不等于 callable**，而一个绕过缺失依赖的 agent 产出的答案看起来毫无破绽，却并非来自那个经过验证的工具。提示词现在明确要求模型报告缺失的包，而不是替它想办法。

所以设置页把「可导入模块」和「可调用函数」显示成**两个分开的数字**，列出各自的阻塞原因，并给出一条能换回最多函数的 `pip install` 命令。命令行上 `/biomni` 输出同样的报告。

### 有些工具会自己调 LLM

`query_uniprot` 等少数几个函数会**在工具内部**调用一个模型把自然语言转成查询，默认走 Anthropic，未配置时以缺包错误失败。范围很窄——`database.py` 和 `genomics.py` 里 4 个调用点，共 183 个函数——但架构上值得注意：这些调用绕过了 `ctx.llm`，因此没有遥测、没有成本核算，也无法从 dsh 这边切换 provider。

Biomni 的 `get_llm` 接受带 `base_url` / `api_key` 的 `Custom` source，调用点会读 `default_config`，所以指向 DeepSeek 的 OpenAI 兼容端点大概是可行的解法。目前未解决；另外 179 个函数是纯 API 和计算封装，不受影响。

---

## 让模型真的去用它

这一段是**实测**出来的，不是推断的。

`run_python` 和另外 25 个工具一起摆出来时，agent 伸手去拿了 `bash`，然后跑 `python3 -c ...`——**系统**解释器，那里面什么库都没有。把工具描述改得更严厉、明确写出这件事，结果没有变化：描述确实到达了模型，模型依然选了 bash。

两个机制按顺序解决了它：

1. **系统提示词分区**（`ctx.systemPrompt`，order 120），声明解释器和模块清单。这修好了**最初的**选择。
2. **`ctx.tools.guard`**，拒绝 bash 里调用 `python` / `pip` 的命令，并在拒绝理由里点名替代方案。这是必需的，因为提示词修好了第一次选择却修不好**回退**：任务中途 agent 仍然试了 `bash python3 -c`，接着是 `source .venv/bin/activate && python3 -c`。拒绝能在循环**内部**纠正它，而提示词做不到。

守卫锚定在命令位置上，所以 `grep python notes.txt` 和 `--with-python=/usr/bin/python3` 会放行；两个方向都有测试钉住。

两者都到位之后，同一个研究任务跑成了 3 次 `run_python`，没有别的。

---

## 沙箱

worker 的 argv 会被 `ctx.sandbox` 按 `ctx.sandboxPolicy` 的策略包裹，因此继承部署的文件效果隔离（macOS 上是 Seatbelt，Linux 上是 bwrap/Landlock）。在 dsh 真实的 `workspace-write` profile 下验证过：workspace 和 temp 写入成功，外部写入被拒绝，并以普通的 `PermissionError` 呈现给模型。

两个诚实的限制：

- **沙箱词汇表只覆盖文件效果。** 它不表达任何网络策略——dsh 自己的 README 就是这么说的。Biomni 风格的工具会自由调用外部 API，隔离约束不到这一点。
- **策略在 worker 启动时解析一次**，不是每次调用。已经在跑的 worker 保留它出生时的隔离；模式变更在下一次 reset 后生效。

---

## 配置

| 键 | 层 | 默认 | 含义 |
|---|---|---|---|
| `python` | 用户设置 | `python3` | 每个会话 worker 的解释器。改动会退役正在运行的解释器。 |
| `timeoutMs` | 用户设置 | `600000` | 单段代码的挂钟上限；超时会重置解释器。 |
| `guardShellPython` | 用户设置 | `true` | 拒绝 bash 里直接调用 python / pip。 |
| `description` | 组合行 | 见 `src/prompt.ts` | 模型可见的工具描述。 |
| `guidance` | 组合行 | 见 `src/prompt.ts` | 描述解释器与其库的提示词分区；空字符串则禁用。 |

前三个是**用户设置**（设置页 / `settings.yaml`），每次访问时解析，改了立即生效。后两个是**组合行**（`cordis.patch.yml`），故意不做成用户设置：它们的文本挂在请求前缀上，会话中途编辑会让 KV 缓存失效。

---

## 开发

```sh
pnpm install
pnpm build          # tsc 出类型 + tsdown 出 lib
pnpm typecheck
pnpm test           # 不需要 biomni
DSH_BIOMNI_PYTHON=/abs/path/.venv/bin/python pnpm run test:biomni
```

Biomni 那条测试在解释器没有 biomni 时是 skip 而不是 fail，所以默认的 `pnpm test` 在裸解释器上也能跑通。

### 两条安装通道

同一份 `src/client/index.tsx` 编译成两个 bundle，只有注册的 id 和文件名不同，所以不会漂移：

| 产物 | 通道 | 注册 id |
|---|---|---|
| `lib/client.js` | profile bundle | `dsh-biomni`（包名——client-modules 按包名组合） |
| `lib/client-registry.js` | plugin registry（`dsh.plugin.json`）| `dsh-external/dsh-biomni`（manifest id——registry 的 `arrive()` 要求 bundle id === plugin id）|

这里的失败模式是**静默的**：id 和通道对不上的 bundle 根本不会激活，哪里都不报错。`tests/bundle.spec.ts` 就是钉这个的。

### 构建期纯度门

client bundle 禁止 value-import 非白名单的 `@deepseek-ai/*`（`tsdown.config.ts` 里的 `dsh-client-bundle-purity` 插件），也禁止任何 Node 内置模块。`import type {}` 会被擦除，不触发门禁——类型可以自由共享，运行时符号不行。

---

## 状态

执行内核、设置页、环境探针和 skill 目录都可用并有测试覆盖 —— Biomni 内核的三块（持久解释器、工具库、检索层）现在都有了对应物。

还没做的：数据湖（76 个数据集，需要额外下载约 11GB，本插件目前不管这件事）和软件库（113 条）的目录，两者的元数据都在 `biomni.env_desc` 里现成可读。

## 许可

MIT
