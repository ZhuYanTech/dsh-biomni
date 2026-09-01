# dsh-biomni 开发约束

> 面向在本仓库工作的 agent 和贡献者。用户文档在 [README.md](./README.md)。

## 0. 硬约束

- **禁止修改 DeepSeek Harness (DSH) 源码**：对官方源码 checkout（`~/.dsh/source/current`）零写入。需要 harness 没有的能力时，用现成的公开 API 或插件自有路由实现；确实做不到就先说明取舍，而不是去改 DSH。
- **挂载只走 `cordis.patch.yml` + profile 机制**。插件永远作为独立包被 profile 引用，不反向侵入 DSH。
- **不得依赖其他插件的运行时符号**。跨插件协作走 cordis service；`import type {}` 会被擦除，可以自由用。

## 1. 两个半区的边界

| | host 半 (`src/*.ts`) | client 半 (`src/client/*`) |
|---|---|---|
| 入口 | `src/index.ts` | `src/client/index.tsx` |
| 产物 | `lib/index.js`（ESM, node） | `lib/client.js` + `lib/client-registry.js`（CJS 闭包工厂, browser） |
| 能用 Node | 能 | **绝对不能**（纯度门会挡） |
| 跨半区共享 | `src/prefs-shared.ts`——**必须不含 schemastery、不含 `node:*`** | 同左 |

`src/context-types.ts` 也在 client 可达的声明图里，同样必须不引用 `node:*` / `Buffer`。

## 2. 设置这条路，别走错

三方 namespace **不能**用 DSH 的 settings RPC——`packages/host/apiproxy` 的 `WEB_SETTINGS_NAMESPACES` 是硬编码 allowlist，进不去的 namespace 一律 `status: 'unavailable'`。

因此本插件的设置走：

```
client: ctx.slots.inject('settings.section', …)   ← 注册整个分区，不是 settings.plugin.item
        ↓ fetch /biomni/api/settings.get|update
host:   ctx.settings.register(ns, PrefsSchema)     ← 进程内持有，无 allowlist
        ctx.settings.describe() / .update(ns, patch, expectedRevision)
```

改动这条链路时必须保住三件事，`tests/api.spec.ts` 钉着：

1. **信任围栏**：非 loopback 且不在 `trustedHosts` 里的 Host 必须 403；
2. **revision 守卫**：`expectedRevision` 过期必须 409（`settings-conflict`），不能静默覆盖；
3. **未知方法 404**，不能因为路由是 prefix 就把任何路径当方法。

## 3. 分层：什么该是用户设置，什么不该

| 层 | 放什么 | 为什么 |
|---|---|---|
| 组合行（`Config`，`cordis.patch.yml`） | `description`、`guidance` | 文本挂在请求前缀上，会话中途改会让 KV 缓存失效 |
| 用户设置（`PrefsSchema`，`biomni` namespace） | `python`、`timeoutMs`、`guardShellPython`、`dataPath` | 路径和限额，改了要立即生效 |

用户设置**必须按访问解析**（`scope.get()` 放在 getter 里），不能在 `apply` 里读一次存下来——否则「改了立即生效」就是假的。

`python` 变更还要 `workers.resetAll()`：已经在跑的解释器保留它出生时的可执行文件，不退役就等于没改。

## 4. 所有的门都不要合并成一个数字

Biomni 广告三类资产，每一类都可能「广告了但这里用不了」。`python/_gates.py` 分轴静态扫描：

| 资产 | 轴 |
|---|---|
| 工具函数 | **门 1** 模块级 import → 模块能不能 import（全有或全无）<br>**门 2** 函数体内的惰性 import → 函数能不能调用 |
| 数据湖 | 广告的文件是否真在盘上；**另外独立一轴**：许可是否允许商用（`env_desc_cm.py`，76 里只有 41） |
| 软件库 | 广告的包 / CLI 是否真的装了（`importlib.metadata` / `shutil.which`） |

**任何两轴都不许合并成一个「可用度」。** 这是这个项目唯一真正会犯的错。一个模块能干净导入，函数照样可能在调用时抛 `ModuleNotFoundError`；一个数据集可以在盘上、可读、并且仍然不许商用。agent 遇到这种落差**不会报告它，会默默编一个**——手搓一个替代函数，或者编一个路径再编一个结果，产出看起来没问题、却不来自被验证的东西。

R 包是唯一允许 `available: null` 的：机器上没有 R 是确定的「没有」，有 R 时逐包检查要各起一个进程，一次目录构建不该干这事。**标 unverified，不要猜。**

`report.gate`（`tqdm` / `pandas`）要单独最响地报出来：它俩通过 `biomni.tool.__init__ → biomni.utils` 一次性卡住全部模块，而且报错不提它们。

## 4b. skill 目录：三条不能破的规则

skill 是**运行时**从配置的解释器生成的（`python/skills.py`），不是随包发的静态 markdown。

1. **目录只登可用的东西。** 门 1 挡住的模块不进目录（底下没一个函数能跑）；门 2 挡住的函数不进「可用」列表。改 `advertisableModules` / `isCallable` 时想清楚：目录里出现一个调不通的函数，就是在制造那个「agent 默默手搓替代品」的场景。
2. **被挡住的函数要点名，不要藏。** body 末尾那段「needs `X`，报告它，不要自己装也不要重新实现」是反造假指令，`tests/skills.spec.ts` 钉着。完全隐藏会让模型靠「调用→失败」重新发现，而实测的失败反应不是干净报错。
3. **`python` 或 `dataPath` 一变就 invalidate。** 从另一个解释器、或另一个数据根目录生成的目录不是陈旧，是错的。`index.ts` 里 `onCatalogChanged` 这条线不能断，provider 的缓存键必须同时含这两个值。注意两者的爆炸半径不同：`python` 变了要连带 `workers.resetAll()`，`dataPath` 变了**不能**——那会白白丢掉用户会话里的命名空间。
4. **数据湖和软件库各只占目录一行。** 76 个数据集、113 条软件如果一条一个 skill，常驻成本会超过它们旁边的模块目录。分组进一个 body，按需加载。
5. **盘上没有就不登。** 一个数据集都没下载 → 没有 `biomni-data-lake` skill。列 76 个不存在的路径，正是第 1 条要防的事，而且在这里更危险。

skill 名必须是 kebab-case（`^[a-z0-9]+(?:-[a-z0-9]+)*$`），而 Biomni 的模块名是 snake_case —— `skillNameOf()` 负责转换，别绕过它。

**全部三类资产的分析只有一份实现**（`python/_gates.py`），`probe.py` 和 `skills.py` 都用它。设置页和 skill 目录对「什么能用」给出两种说法，是这里最容易犯也最难查的错。`tests/biomni.spec.ts` 有专门比对两者的用例（函数、数据湖、软件库各一条）。

## 4d. shell 守卫：守的是「对的解释器」，不是「没有 Python」

`src/guard.ts` 现在按这条不变量写，别退回去：

- 到达**别的**解释器 → 拒绝，并且拒绝理由里要点名该用哪个；
- 用**绝对路径**写出本会话配置的那个解释器 → **放行**。它到达对的库、对的 Python，只丢掉持久命名空间——降级，不是错误。

这条放行是整个设计的兜底：正则永远枚举不完（`uv run` / `conda run` / `poetry run` / Makefile / shell 脚本…），有了它，漏掉一个模式就不再是正确性事故。**加新的包装形式往 `WRAPPERS` 里加，但不要指望它完备。**

两条例外，别放宽：`pip` 在任何路径下都不放行（装包要走 operator）；配置成裸 `python3` 时不放行任何东西（那时「配置的解释器」就是要防的那个系统解释器）。

Biomni 软件库里那 18 个 CLI（samtools / bwa / bedtools…）**本来就该走 bash**，守卫只认 `python` / `pip`，别把它们卷进来。

## 4e. 数据湖：清单是白名单，许可是独立的一道门

`python/fetch.py` 是这个插件唯一会写盘、会拉网络的东西，两条拒绝规则不能松：

1. **不在清单里的名字直接拒绝，不拼 URL。** 清单就是白名单——这是它不能被指向任意主机或路径的唯一原因。`tests/kernel.spec.ts` 用路径穿越的名字钉着。
2. **非商用数据集必须显式确认。** 76 个里有 35 个不在 Biomni 的商用子集内。许可在这个项目里从头到尾是**独立于可用性**的一根轴，这里是它真正生效的那一点，也是唯一一件删文件撤不回来的事。UI 上禁用按钮只是给人看的，真正的门在 `fetch.py` 里，绕不过去。

**取数据不做成模型可见的工具，也不做成带参数的斜杠命令。** 它是运维动作：带着一个法律判断和最多 6 GB 的下载量，跟这个插件对待「装包要问 operator」是同一套逻辑。`/biomni-datasets` 只读，写在受围栏的 API 上。

下载先落 `.part` 再改名。半个文件在探针眼里是「已存在」，比没有更糟。

**体积必须来自清单，不能现问网络。** Biomni 自己的 `env_desc` 不记体积（它的下载器整套拉，不需要），所以 `manifest()` 会把捕获到的体积**合并**进 live 目录。少了这步，装了 Biomni 反而比不装更难用——这种反转没人会想到去查，`tests/probe.spec.ts` 钉着。

## 4f. 产出目录：唯一一条把名字变成文件路径的通道

`src/artifacts.ts` 的 `resolveArtifact` 是全项目唯一一处「HTTP 来的名字 → 文件系统路径」的转换，所以规则最紧：

1. **两边都走 `realpath` 再比较，不能只用 `path.resolve`。** `resolve` 只在字面上折叠 `..`，**不跟随符号链接**——而往这个目录里写东西的正是一个能调 `os.symlink` 的 agent。`BIOMNI_OUT/notes.txt -> /etc/passwd` 能通过所有字面检查。这个洞是 0.2.0 写测试时发现的，`tests/kernel.spec.ts` 用**真实 run_python 调用创建的链接**钉着。
2. **比较必须带分隔符**：`startsWith(base)` 会放过同级的 `biomni-out-evil`。
3. **所有失败一律 404**，不区分「不存在」和「越界」——否则这条路由就成了探测周边文件系统的工具。

**永远不发 `text/html`。** 这些是模型写的文件，从 harness 自己的 origin 提供；就地渲染等于把「写文件」变成在那个 origin 上执行脚本的通道。一律 `attachment` + `nosniff`，认不出的扩展名走 `application/octet-stream`。

**下载有 100 MB 上限，因为响应接口只收整个 body、不支持流式。** 超过就拒绝并给出绝对路径——文件本来就在用户自己的工作区里，浏览器下载从头到尾只是个便利。

**目录只读。** agent 写，operator 看和取。这个页面上不应该出现删除按钮：它会是唯一一个会销毁工作成果的控件，而用户手边就有 `rm`。

**预览的三条边界。** 预览是**有界的服务端读取**，不是「让浏览器把整个文件拉下来自己看」——2 MB 内联图片、64 KB 文本头、50 行 × 30 列表格，超出的部分明确标注为截断。三点不能改：

1. **`svg` 和 `html` 不走图片预览，只看源码。** 两者都是能带脚本的文档，而写它们的是 agent；就地渲染等于把 harness 的 origin 交出去。这跟「永远不发 `text/html`」是同一条规矩的两面。
2. **CSV/TSV 必须按 RFC 4180 拆字段**（`splitDelimited`）。基因描述里全是逗号，按分隔符裸切会让后面每一列悄悄错位——一个静默错位的表比没有预览更糟，它会让人从错读的表里得出结论。
3. **哪些扩展名能预览，只有 `src/artifacts-shared.ts` 一份表**，host 和 client 都从它读。两边各写一份就会漂移，而漂移的表现是安静的：一个永远回答「无法预览」的按钮，或者一个能预览却没有入口的文件。这个文件不许出现 `node:` 导入，否则客户端 bundle 纯净性检查会挂。

## 4g. 解释器的寿命：回收可以，静默不行

一个解释器就是一个 Python 进程，装着这个会话 import 过的一切。实测：常用那套（numpy / pandas /
scipy / matplotlib / scikit-learn）装载后常驻 **298 MB**，空解释器 **74 MB**。所以有闲置回收。

**回收必须被上报。** 这是这个功能里唯一不能删的部分。命名空间悄悄清空，和一个没被声明的缺失依赖
是同一类失败：模型接着用一小时前 load 的 `df` 推理，而它已经不在了。所以 `WorkerPool.get()` 会在
回收之后的**第一次**取用上挂一个 `retiredBecause`，由 `run_python` 转成一句**放在输出最前面**的
通知——放在后面等于没写，模型读完结果就走了。

三条容易破的：

1. **闲置时钟从调用「结束」开始算**（`workers.touch(owner)` 在 `finally` 里）。只在 `get()` 时上弦，
   一段跑一小时的代码会在自己还在跑的时候把解释器回收掉。
2. **`0` 要原样穿过 clamp**（`clampIdleTimeoutMs`）。它的意思是「不回收」；折到 5 分钟下限会让
   「别动我的解释器」变成整页最激进的设置。
3. **`reset()` 不留债，`resetAll('settings')` 留。** 前者是调用方自己要求的（超时、崩溃），它已经
   在告诉模型了，再加一句就是重复；后者是运维改了解释器路径，模型完全不知情。

## 4c. 两种安装形态的分工，以及一条硬约束

| 形态 | 承载 | 作用域 |
|---|---|---|
| profile bundle | 能力（`run_python`、设置页、skill 目录） | 整个 profile |
| agent preset | 框架（生物医学人格） | 单个 agent |

**preset 挂不了本插件。** preset 行里的裸包名从 harness 安装目录解析，不是 profile 的 node_modules（`@deepseek-ai/dsh-agent-presets` 的 `PresetTree.import`，注释写得很明确）；相对路径同样不行，因为 preset 目录下没有 node_modules 能解析本插件的依赖（dsh-science 把引擎做成零依赖正是为了绕开这点）。别再试了，也别为此把插件改成零依赖。

`scripts/install-preset.sh` **从用户自己的 harness 生成** composition，只替换人格行。不要改成往仓库里 vendor 一份 standard preset 的拷贝：那会随 dsh 版本静默漂移，症状是 agent 悄悄少了个工具。

## 4d. 挂载验证不能省

`test/verify-bundle.sh` 是本仓库唯一证明「绕开 allowlist 的设置方案在真实 dsh 上成立」的东西。改动 `src/api.ts`、`src/index.ts` 的路由挂载、`src/client/index.tsx` 的 slot 注册，或 `package.json` 的 `dsh` / `files` 字段之后，都要重跑它。

两个反复踩到的点：

- **patch 行是替换，不是合并。** 只写 `port` 会丢掉 `host`，报错是 `$.host missing required value`，看起来像插件的问题。
- **启动检查必须要求服务真的起来。** 用 `|| true` 启动再只 grep 自己的行名，webserver 起不来也照样"通过"。

## 5. 守卫的两个方向都要测

`SHELL_PYTHON` 锚定在命令位置。改这个正则时，`tests/guard.spec.ts` 的两张表都要过：

- 必须拒绝：`FOO=1 python3 x.py`、`sudo pip3 install x`、`source .venv/bin/activate && python3 -c …`
- 必须放行：`grep -rn python notes.txt`、`--with-python=/usr/bin/python3`、`git commit -m "python cleanup"`

**过度拒绝比不拒绝更糟**：模型绕不过去，也看不懂为什么。

## 6. 两条安装通道

同一份 `src/client/index.tsx` 编译成两个 bundle，**只有注册 id 和文件名不同**：

| 产物 | 通道 | 注册 id | 来源 |
|---|---|---|---|
| `lib/client.js` | profile bundle | `dsh-biomni` | `package.json` 的 `name` |
| `lib/client-registry.js` | plugin registry | `dsh-external/dsh-biomni` | `dsh.plugin.json` 的 `id` |

**失败模式是静默的**：id 和通道对不上，bundle 根本不激活，哪里都不报错。改包名或 manifest id 时，`tsdown.config.ts` 里的两处也要跟着改，`tests/bundle.spec.ts` 会拦住不一致。

## 7. headless 兼容

`webServer` / `webRuntime` **不在**顶层 `inject` 里，路由从 `ctx.inject([...], …)` 的子 fiber 挂载。写进顶层会让插件在 headless profile 下完全无法激活——为了一个那里根本不存在的 UI，搭进去整个 `run_python`。`tests/kernel.spec.ts` 的 headless 用例钉着这一点。

## 8. 测试约定

| spec | 覆盖 | 需要 |
|---|---|---|
| `kernel.spec.ts` | 工具注册、跨调用状态、子进程捕获、traceback 过滤、串行化、headless、无 skills 服务 | 一个裸 `python3` |
| `guard.spec.ts` | 守卫两个方向的边界 | — |
| `skills.spec.ts` | 目录筛选、body 渲染、provider 缓存与失效、降级 | — |
| `prefs.spec.ts` | 客户端逐字段回退与钳制 | — |
| `api.spec.ts` | 信任围栏、revision 守卫、错误映射 | — |
| `bundle.spec.ts` | 两条通道的产物形状、manifest 一致性 | `pnpm build` |
| `biomni.spec.ts` | 真实 Biomni 解释器；**探针与 skill 目录的一致性** | `DSH_BIOMNI_PYTHON` |

**stub 必须照着真实 seam 的类型写，不是照着「能过」写。** 上一版的 stub 自己发明了一个 async `read()`，测试全绿，接到真 dsh 上就炸了——真实的 reader 是同步的 `readFrom(offset)`。`tests/stubs.ts` 的每个形状都是从 `src/context-types.ts` 抄的。
