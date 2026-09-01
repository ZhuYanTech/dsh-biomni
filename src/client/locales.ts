/**
 * zh/en copy for the Biomni settings section.
 *
 * Follows the DSH i18n system: the client apply attaches the locale service
 * (`ctx.locale`, provided by `@deepseek-ai/dsh-client-locale`) through
 * {@link attachLocale}, and `t()` resolves the active locale from it — the
 * Host-backed `locale.preference` wins over the raw browser language and
 * switches live. Without an attached service (standalone/test compositions)
 * the browser language is used. The dictionaries are also registered into the
 * DSH locale registry under {@link LOCALE_NS}.
 */

/** The zh dictionary. */
export const zh = {
  settingsNav: 'Biomni',
  intro: '会话级持久 Python 解释器，装载 Biomni 生物医学工具库。',

  interpreterHeading: '解释器',
  pythonLabel: 'Python 解释器',
  pythonDesc: '每个会话的工作进程由它启动。默认的 python3 是系统解释器，没有 Biomni 的依赖库；请指向按 requirements-biomni.txt 建好的虚拟环境。修改会退役正在运行的解释器，下一次调用从空命名空间开始。',
  pythonPlaceholder: '/abs/path/to/.venv/bin/python',
  dataPathLabel: '数据湖根目录',
  dataPathDesc: '存放 biomni_data/data_lake 的那一层目录，也就是 Biomni 自己所说的 path。留空则按 Biomni 的规则解析：$BIOMNI_PATH、$BIOMNI_DATA_PATH、然后 ./data。改动会让 skill 目录立即重建——针对另一个根目录生成的数据集清单不是「陈旧」，是错的。',
  dataPathPlaceholder: '留空 = 按 Biomni 的规则解析',
  timeoutLabel: '单次执行超时',
  timeoutDesc: '一段代码的挂钟时间上限。超时会重置该会话的解释器——调用被中途放弃后，它的状态已不可知。',
  timeoutUnit: '秒',
  idleLabel: '闲置回收',
  idleDesc: '一个解释器多久没被调用就退役。实测：装完常用那套（numpy / pandas / scipy / matplotlib / scikit-learn）之后，一个进程常驻 298 MB，空解释器是 74 MB——几个开着过夜的会话就是一个 G。回收会清空命名空间，所以下一次调用会明确告诉模型「你的解释器被回收了，重新准备」，而不是让它撞上 NameError。填 0 表示不回收，跟着 agent 的生命周期走。',
  idleUnit: '分钟（0 = 不回收）',
  guardLabel: '拦截 shell 中的 python',
  guardDesc: '拒绝 bash 里直接调用 python / pip 的命令，并引导模型改用 run_python。实测：仅靠提示词只能纠正模型的第一次选择，任务中途它仍会回退到 bash python3 -c，落到没有依赖库的解释器上。',

  environmentHeading: '环境',
  probe: '检测环境',
  probing: '检测中…',
  probeFailed: '无法检测解释器',
  neverProbed: '尚未检测。检测会用当前解释器启动一个一次性进程，静态扫描 Biomni 工具库的两道依赖门，并核对数据湖和已安装的生信软件。',

  interpreterField: '解释器',
  pythonVersionField: 'Python',
  biomniVersionField: 'Biomni',
  notInstalled: '未安装',
  notInstalledHint: '这个解释器里没有 Biomni。用 python/requirements-biomni.txt 安装后，把上面的 Python 解释器指向它。',

  gateWarning: '{packages} 缺失，这会挡住全部 {total} 个工具模块——而且报错不会提到它们。请先装这两个。',
  modulesLabel: '可导入模块',
  functionsLabel: '可调用函数',

  blockedHeading: '无法导入的模块',
  blockedHint: '模块顶层的 import 是全有或全无：缺一个依赖，整个模块都用不了。',
  needs: '需要',

  missingHeading: '可导入，但调用时会抛 ModuleNotFoundError',
  missingHint: '这些函数在函数体里才 import 依赖，模块级的静态分析发现不了。这不是长尾——单个 scipy 就挡住几十个函数。',
  functionsCount: '{n} 个函数',
  andMore: '还有 {n} 个包',
  copyPip: '复制 pip 命令',
  copied: '已复制',


  dataLakeHeading: '数据湖',
  dataLakeLoading: '正在读取数据集目录…',
  dataLakeEmpty: '读不到数据集目录。检查上面的 Python 解释器路径。',
  dataLakeFailed: '无法读取数据湖',
  dataLakePath: '数据集读写位置：{path}',
  dataLakeFilter: '按名字或描述筛选…',
  onDiskLabel: '已在盘上',
  wholeLakeLabel: '整套数据湖',
  onDiskHeading: '已在盘上（{n}）',
  fetchableHeading: '可获取（{n}）',
  onDisk: '已在盘上',
  fetch: '获取',
  fetching: '获取中…',
  fetched: '已获取',
  nonCommercial: '仅限非商用',
  acceptNonCommercial: '我了解非商用限制',
  acceptNonCommercialDesc: '76 个数据集里有 35 个不在 Biomni 的商用子集内。限制是法律层面的，不是技术层面的——文件照样能读。勾选后才能获取这些数据集。',
  andMoreDatasets: '还有 {n} 个，用上面的筛选框缩小范围。',


  artifactsHeading: '产出文件',
  artifactsLoading: '读取中…',
  artifactsEmpty: '读不到输出目录。',
  artifactsFailed: '无法读取输出目录',
  artifactsNone: '还没有产出。解释器的命名空间里已经绑好了 BIOMNI_OUT——它往那里写的任何东西都会出现在这里，可直接下载。',
  artifactsPath: '位置：{path}',
  filesLabel: '个文件',
  totalLabel: '合计',
  download: '下载',
  preview: '预览',
  previewHide: '收起',
  previewLoading: '读取中…',
  previewFailed: '无法预览',
  previewNone: '这个文件没有可用的预览。',
  previewTruncated: '只显示了开头部分——完整内容请下载。',
  refresh: '刷新',
  justNow: '刚刚',
  minutesAgo: '{n} 分钟前',
  hoursAgo: '{n} 小时前',
  daysAgo: '{n} 天前',
  andMoreFiles: '还有 {n} 个文件未列出。',

  saveFailed: '保存失败',
  conflict: '设置已被其他地方修改，已重新载入',
}

/** The en dictionary. */
export const en: Record<keyof typeof zh, string> = {
  settingsNav: 'Biomni',
  intro: 'A persistent, per-session Python interpreter provisioned with Biomni\'s biomedical tool library.',

  interpreterHeading: 'Interpreter',
  pythonLabel: 'Python interpreter',
  pythonDesc: 'Each session\'s worker is spawned from this. The default python3 is the system interpreter, which has none of Biomni\'s library — point it at the venv built from requirements-biomni.txt. Changing it retires running interpreters; the next call starts with an empty namespace.',
  pythonPlaceholder: '/abs/path/to/.venv/bin/python',
  dataPathLabel: 'Data lake root',
  dataPathDesc: 'The directory that CONTAINS biomni_data/data_lake — what Biomni itself calls path. Leave empty to resolve as Biomni does: $BIOMNI_PATH, $BIOMNI_DATA_PATH, then ./data. Changing it rebuilds the skill catalog at once: a dataset listing generated against another root is not stale, it is wrong.',
  dataPathPlaceholder: 'empty = resolve as Biomni does',
  timeoutLabel: 'Snippet timeout',
  timeoutDesc: 'Wall-clock limit for one snippet. A timeout resets that session\'s interpreter: its state is unknowable once a call is abandoned mid-execution.',
  timeoutUnit: 'seconds',
  idleLabel: 'Retire idle interpreters',
  idleDesc: 'How long an interpreter may sit unused before it is retired. Measured: a worker with the usual stack imported (numpy, pandas, scipy, matplotlib, scikit-learn) holds 298 MB resident against 74 MB bare — a few sessions left open overnight is a gigabyte. Retiring one empties the namespace, so the next call TELLS the model its interpreter was retired and to set up again, rather than letting it walk into a NameError. 0 keeps every interpreter for the life of its agent.',
  idleUnit: 'minutes (0 = never)',
  guardLabel: 'Guard shell python',
  guardDesc: 'Deny bash commands that invoke python or pip directly, redirecting the model to run_python. Measured: prompt guidance alone fixes only the model\'s FIRST choice — mid-task it still falls back to bash python3 -c, reaching an interpreter without the library.',

  environmentHeading: 'Environment',
  probe: 'Probe environment',
  probing: 'Probing…',
  probeFailed: 'Could not probe the interpreter',
  neverProbed: 'Not probed yet. Probing starts a throwaway process with the current interpreter, statically checks both of Biomni\'s dependency gates, and verifies the data lake and installed bioinformatics software.',

  interpreterField: 'Interpreter',
  pythonVersionField: 'Python',
  biomniVersionField: 'Biomni',
  notInstalled: 'not installed',
  notInstalledHint: 'Biomni is not installed in this interpreter. Install it with python/requirements-biomni.txt, then point the interpreter above at it.',

  gateWarning: '{packages} missing — this blocks ALL {total} tool modules, and the import error will not name them. Install these first.',
  modulesLabel: 'Modules importable',
  functionsLabel: 'Functions callable',

  blockedHeading: 'Not importable',
  blockedHint: 'Module-level imports are all-or-nothing: one absent dependency takes the whole module out.',
  needs: 'needs',

  missingHeading: 'Importable, but these raise ModuleNotFoundError when called',
  missingHint: 'These functions import their dependencies inside the body, so no module-level analysis finds them. Not a long tail either — scipy alone gates dozens.',
  functionsCount: '{n} functions',
  andMore: 'and {n} more packages',
  copyPip: 'Copy pip command',
  copied: 'Copied',


  dataLakeHeading: 'Data lake',
  dataLakeLoading: 'Reading the dataset catalog…',
  dataLakeEmpty: 'No dataset catalog. Check the Python interpreter path above.',
  dataLakeFailed: 'Could not read the data lake',
  dataLakePath: 'Datasets are read from and written to {path}',
  dataLakeFilter: 'Filter by name or description…',
  onDiskLabel: 'on disk',
  wholeLakeLabel: 'whole lake',
  onDiskHeading: 'On disk ({n})',
  fetchableHeading: 'Available to fetch ({n})',
  onDisk: 'on disk',
  fetch: 'Fetch',
  fetching: 'Fetching…',
  fetched: 'Fetched',
  nonCommercial: 'non-commercial only',
  acceptNonCommercial: 'I understand the non-commercial restriction',
  acceptNonCommercialDesc: '35 of the 76 datasets sit outside Biomni\'s commercial-use subset. The restriction is legal, not technical — the files read the same either way. Fetching those needs this ticked.',
  andMoreDatasets: '{n} more; narrow the filter above.',


  artifactsHeading: 'Output files',
  artifactsLoading: 'Reading…',
  artifactsEmpty: 'Could not read the output directory.',
  artifactsFailed: 'Could not read the output directory',
  artifactsNone: 'Nothing written yet. The interpreter has BIOMNI_OUT bound in its namespace — anything it saves there appears here, ready to download.',
  artifactsPath: 'Location: {path}',
  filesLabel: 'files',
  totalLabel: 'total',
  download: 'Download',
  preview: 'Preview',
  previewHide: 'Hide',
  previewLoading: 'Reading…',
  previewFailed: 'Could not preview',
  previewNone: 'No preview available for this file.',
  previewTruncated: 'Showing the beginning only — download for the whole file.',
  refresh: 'Refresh',
  justNow: 'just now',
  minutesAgo: '{n} min ago',
  hoursAgo: '{n} h ago',
  daysAgo: '{n} d ago',
  andMoreFiles: '{n} more files not listed.',

  saveFailed: 'Could not save',
  conflict: 'Settings changed elsewhere; reloaded',
}

/** The dictionary namespace this plugin owns in the DSH locale registry. */
export const LOCALE_NS = 'biomni'

/** The DSH locale service attached by the client apply (absent → browser detection). */
let localeService: { getSnapshot(): { active: string } } | undefined

/** Attach (or detach, with undefined) the DSH locale service. */
export function attachLocale(service: { getSnapshot(): { active: string } } | undefined): void {
  localeService = service
}

/** The active locale id ('zh' | 'en'): the service snapshot when attached, else the browser language. */
function activeLocale(): string {
  return localeService?.getSnapshot().active
    ?? (typeof navigator !== 'undefined' ? navigator.language : '')
    ?? 'en'
}

/** A copy key. */
export type CopyKey = keyof typeof zh

/** Translate a copy key; `{name}` placeholders interpolate from `params`. */
export function t(key: CopyKey, params?: Record<string, string | number>): string {
  const dict = activeLocale().toLowerCase().startsWith('zh') ? zh : en
  let text: string = dict[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}
