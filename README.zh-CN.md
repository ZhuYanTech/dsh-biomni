<div align="center">

# dsh-biomni

**把生物医学研究能力接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。**

一个持久的 Python 解释器，[Biomni](https://github.com/snap-stanford/Biomni) 的 218 个研究函数、
76 个数据集的数据湖、113 个生信工具 —— 以 skill 的形式交给你的 agent，
而且**只承诺这台机器真的做得到的事**。

[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-5b6cff)](https://github.com/topics/dsh-plugin)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

[English](./README.md) · **简体中文**

</div>

---

## 它防的是哪种失败

给 agent 一套生物医学工具库，它会以一种特别难查的方式出错。

它调用 `query_pubmed`。函数是存在的，但依赖从没装上，于是抛异常。**agent 不会报告这个落差**——
它会默默手搓一个自己的 PubMed 客户端，然后把结果当作那个被验证过的工具的输出交给你。让它去访问一个
根本没下载的数据湖，同样的事会发生在文件路径上：先编一个看着合理的路径，再编一个看着合理的结论。

**dsh-biomni 只有一条规矩：绝不宣传这台机器给不出的东西。** 你的 agent 看到的一切——每个函数、每个
数据集、每个命令行工具——都是先检查你的真实环境之后生成的。缺的东西要么不出现，要么被点名，连同它缺什么。

## 你的 agent 会拿到什么

| | |
|---|---|
| 🐍 **一个记得住事的解释器** | 每个会话一个进程。import、DataFrame、拟合好的模型都能从这次调用活到下次，agent 因此可以分小步推进，而不是每次重发一整个脚本。 |
| 🧬 **21 个研究函数 skill** | Biomni 的生物医学库，每个模块一个 skill，带真实签名——参数类型、默认值，以及每个参数到底是什么意思。按需加载，所以 218 个函数占约 1.6k token 常驻，而不是 26k。*（需要装 Biomni）* |
| 🗄️ **一个数据湖 skill** | 这台机器上**真的下载了**的数据集，带确切路径、体积和许可标记。能用本地数据就别绕一圈去查网。 |
| 🔧 **一个软件 skill** | 这台机器上**真的装了**的生信包和 CLI 工具——让 agent 去调 `samtools`，而不是自己重写一个。 |
| 🔍 **一份诚实的环境报告** | `/biomni` 命令和设置页，如实告诉你什么能用、什么不能、以及装哪个包能修好。 |

它是一个普通的 out-of-tree 插件，不 fork、也不改 harness 源码。

## 安装

### 1. 装插件

```sh
dsh plugin --profile web add dsh-biomni
```

就这一步。CLI 会读本包的 `dsh.bundle.patch` 声明，把 `dsh-biomni` 追加进你 profile 的 bundles，
不需要手改 profile 文件。

<details>
<summary>从源码装（开发用）</summary>

```sh
git clone https://github.com/ZhuYanTech/dsh-biomni && cd dsh-biomni
bash scripts/install.sh web
```

这条路打出的 tarball 里 `lib/` 是预构建好的，pnpm 不需要为它跑任何构建脚本。

</details>

### 2. 建一个装了 Biomni 的 Python 环境

**可选，而且值得知道为什么。** 数据湖和软件目录**立刻就能用** —— 它们读的是随插件发布的一份清单，
再对着你这台机器逐项核对。只有那 21 个工具模块 skill 需要 Biomni 本体，因为那些是真的要 import 的 Python。

Biomni 的库需要 Python 3.11+。macOS 自带的是 3.9，装不了。

```sh
curl -sLO https://raw.githubusercontent.com/ZhuYanTech/dsh-biomni/main/python/requirements-biomni.lock.txt
python3.11 -m venv .venv
.venv/bin/pip install -r requirements-biomni.lock.txt
```

实测：**77 个包，806 MB，Biomni 的 312 个函数里 279 个可调用。**

Biomni 只声明了三个依赖，实际需要的远不止，所以 `requirements-biomni.txt` 是读它源码整理出来的
真实清单，逐条标注了每个包解锁什么。旁边的 `.lock.txt` 把所有传递依赖的版本钉死，两个人隔一周装
也能得到同一个解释器。

有四个包被移出了 core 档，放在 `requirements-biomni-extras.txt`，因为实测它们的代价远超收益：

| | 独占体积 | 买到 |
|---|---|---|
| `rdkit` | 151 MB | 1 个函数 |
| `cobra` | 147 MB | 2 个函数 |
| `scholarly` | 119 MB（要驱动一个真浏览器） | 1 个函数 |
| `statsmodels` | 68 MB | 2 个函数 |

加起来 **494 MB 换 7 个函数**。需要那七个就装，别的什么都不变。探针会连价格一起报出来，
而不是把它们当免费的建议给你。

### 3. 指向那个解释器

启动 `dsh --profile web`，打开 **设置 → Biomni**，把 Python 解释器填成
`/abs/path/to/.venv/bin/python`。改动立即生效。

也可以直接写进 `$DSH_HOME/settings.yaml`：

```yaml
biomni:
  python: /abs/path/to/.venv/bin/python   # 第 2 步建的 venv
  dataPath: /abs/path/to/data             # 可选：存放 biomni_data/ 的那一层
  timeoutMs: 600000
  guardShellPython: true
```

### 4. 看看你实际拿到了什么

```
/biomni
```

哪些模块能导入、哪些函数能调用、哪些数据集在盘上、哪些工具装了——以及每一项缺失对应装哪个包能修好。
和设置页是同一组数字，因为两边读的是同一份分析。

### 可选：生物医学人格

插件本身给所有 agent 提供解释器和 skill。如果你想让某一个 agent 被**框定**成生物医学研究者——开场先加载
workflow skill、遇到缺包如实上报而不是绕过去——装上随包附带的 preset：

```sh
pnpm run install:preset
```

## 需要知道的几件事

**「能导入」和「能调用」是两个数字。** 一个 Biomni 模块可以干净导入，它的函数照样可能在调用时抛异常，
因为有些依赖是在函数体里才 import 的。dsh-biomni 把这两个数分开报，绝不平均成一个分数——一个
「可用度 82%」恰好会盖住那个导致「编造结果」的落差，而那正是这个项目要防的事。

**数据湖要你自己下。** 76 个数据集约 11 GB，走 Biomni 自己的下载流程，不归这个插件管。一个都没下载
就是没有数据湖 skill —— 这是一个确定的答案，不是失败。

**部分数据集不许商用。** Biomni 提供了一个商用子集（76 里的 41 个）。一个数据集可以已下载、可读、
但仍然受限，所以许可被当作独立的一件事追踪，并在 skill 里点名。

**Python 归 `run_python`，不归 shell。** 有一道守卫拦住 agent 通过 bash 摸到别的解释器——但用绝对路径
写出**你配置的那个**解释器的调用会被放行，因为那条路到达的是对的库。`samtools` 这类 CLI 工具照常走
bash，只有 `python` 和 `pip` 受限。

## 底下是怎么回事

Biomni 用 `ToolRetriever`（基于向量嵌入的检索器）解决「200+ 个工具 schema 塞不进上下文」的问题。
DSH 的 skill 系统本身就是这个东西，而且形状更好：会话目录里每个 skill 只挂名字和一行描述，完整内容由
模型通过 `skill` 工具按需加载。不需要嵌入、不需要相似度、不需要一个会选错的检索器——选择由模型自己的
判断做出。

在本仓库工作的贡献者和 agent 请先读 [AGENTS.md](./AGENTS.md)，那里写着一批容易破坏、又不容易发现的约束。

## 许可

MIT。Biomni 本身也是 MIT；它数据湖里的各个数据集有各自的条款。
