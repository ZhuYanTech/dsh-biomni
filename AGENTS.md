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
| 用户设置（`PrefsSchema`，`biomni` namespace） | `python`、`timeoutMs`、`guardShellPython` | 路径和限额，改了要立即生效 |

用户设置**必须按访问解析**（`scope.get()` 放在 getter 里），不能在 `apply` 里读一次存下来——否则「改了立即生效」就是假的。

`python` 变更还要 `workers.resetAll()`：已经在跑的解释器保留它出生时的可执行文件，不退役就等于没改。

## 4. 探针的两道门，不要合并成一个数字

`python/probe.py` 静态扫描 Biomni 的两道依赖门：

- **门 1**：模块级 import → 模块能不能 import（全有或全无）
- **门 2**：函数体内的惰性 import → 函数能不能调用

**这两个数字必须分开呈现。** 把它们合并成一个「可用度」是这个 UI 唯一真正会犯的错：一个模块能干净导入，它的函数照样可能在调用时抛 `ModuleNotFoundError`，而 agent 遇到这种情况会**默默手搓一个替代实现**，产出看起来没问题、却不来自被验证工具的答案。

`report.gate`（`tqdm` / `pandas`）要单独最响地报出来：它俩通过 `biomni.tool.__init__ → biomni.utils` 一次性卡住全部模块，而且报错不提它们。

## 4b. skill 目录：三条不能破的规则

skill 是**运行时**从配置的解释器生成的（`python/skills.py`），不是随包发的静态 markdown。

1. **目录只登可用的东西。** 门 1 挡住的模块不进目录（底下没一个函数能跑）；门 2 挡住的函数不进「可用」列表。改 `advertisableModules` / `isCallable` 时想清楚：目录里出现一个调不通的函数，就是在制造那个「agent 默默手搓替代品」的场景。
2. **被挡住的函数要点名，不要藏。** body 末尾那段「needs `X`，报告它，不要自己装也不要重新实现」是反造假指令，`tests/skills.spec.ts` 钉着。完全隐藏会让模型靠「调用→失败」重新发现，而实测的失败反应不是干净报错。
3. **`python` 一变就 invalidate。** 从另一个解释器生成的目录不是陈旧，是错的。`index.ts` 里 `onPythonChanged` 这条线不能断。

skill 名必须是 kebab-case（`^[a-z0-9]+(?:-[a-z0-9]+)*$`），而 Biomni 的模块名是 snake_case —— `skillNameOf()` 负责转换，别绕过它。

**两道门的分析只有一份实现**（`python/_gates.py`），`probe.py` 和 `skills.py` 都用它。设置页和 skill 目录对「什么能调用」给出两种说法，是这里最容易犯也最难查的错。`tests/biomni.spec.ts` 有一条专门比对两者的用例。

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
