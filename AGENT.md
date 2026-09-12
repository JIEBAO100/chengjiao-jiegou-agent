# AGENT.md · 成交结构拆解智能体（Agent 说明）

> 这份文档说明：本作品是一个怎样的 Agent、用了哪些**官方开源资源**、
> 怎么安装与运行、以及结论怎么解释。评委可直接按本文复现。

---

## ⭐ 30 秒看懂：我们怎么用了币安官方的 Skills Hub

官方 Skills Hub 提供现成的「技能包」给 AI Agent 用，其中 **`binance` 技能**的
Market 区块提供免密钥的行情能力（`agg-trades` 聚合逐笔、K线等）——这就是官方说的
「**市场情报**」能力。

本作品的用法：

1. **本作品本身就是一个技能**（`skills/chengjiao-jiegou/SKILL.md`，按官方规范编写），
   评委可用官方安装器一键装载：`npx skills add https://github.com/JIEBAO100/chengjiao-jiegou-agent`
2. **数据直接来自币安官方**（三种方式，都不需要 API 密钥）：
   - `node agent.mjs BTC --skill` → 直接调用官方技能的 `binance-cli` 工具取逐笔
   - `node agent.mjs BTC --official` → 读币安官方开源的公开数据仓库（历史逐笔文件）
   - `node agent.mjs BTC --live` → 走币安官方公开行情入口（与官方技能同一个接口）
3. **官方技能没做的部分由我们补上**：官方技能给的是「数据能力」，
   大小单拆解、主力吸筹/出货研判这个「分析能力」是本作品自研的增量。

一句话：**用官方技能包拿数据，用我们自己的引擎出结论。**

---

## 一、本 Agent 是什么

**成交结构拆解智能体**是一个「数据分析型 Agent」：把某个币种的逐笔成交拆成大单 / 中单 / 小单，
再用十二个订单流特征量研判当前盘面属于**主力真实吸筹 / 主力诱多出货 / 纯散户行情无主力**，
并同时给出三条行为分数与支持、反对证据。

它是一个**纯规则、可复现**的 Agent（不依赖大模型）：同样输入必然得到同样输出，
每条结论都能指出触发条件与具体数值。

---

## 二、用到的官方开源资源（真实调用，非挂名）

官方 GitHub 组织（<https://github.com/binance>）下的公开资源，我们逐个核对过适配性，
实际使用与取舍如下：

| 官方资源 | 本作品的用法 | 状态 |
|---|---|---|
| **[binance-public-data](https://github.com/binance/binance-public-data)**<br>历史公开数据（`data.binance.vision`） | `--official` 通道：下载并流式解析官方每日 aggTrades 文件（现货 `spot/daily/aggTrades`、永续 `futures/um/daily/aggTrades`） | ✅ **已集成并实测**（实测 SOL 20 分钟窗口：4.8 MB 文件、扫描 34 万行、窗口内 2 296 笔、1 秒出结论） |
| **[binance-spot-api-docs](https://github.com/binance/binance-spot-api-docs)**<br>现货 API 与行情流官方文档 | 按该文档实现的**公开行情入口** `data-api.binance.vision`：`--live` 通道的 `aggTrades` / `klines` / `ticker/24hr` 均取自这里（这是官方为「仅需公开行情」场景提供的公开地址，不需要 API 密钥，也不返回账户信息） | ✅ **已集成并实测**（实测 BTC：9 个时间桶、覆盖率 79.3%、结论「主力真实吸筹」置信度 90%） |
| **[binance-skills-hub](https://github.com/binance/binance-skills-hub)**<br>官方技能市场 | **① 本作品的技能定义** `skills/chengjiao-jiegou/SKILL.md` 完全遵循其公布的技能格式（YAML 头部 + 结构化说明 + 触发条件），可用官方安装器装载（`npx skills add`）；<br>**② `--skill` 通道直接调用官方 `binance` 技能**：该技能的 `references/spot.md` 中 Market 区块（无需鉴权）提供 `agg-trades` 等行情命令，本作品在检测到 `binance-cli`（官方技能驱动的命令行工具）时直接调用它取实时逐笔；未安装时如实打印官方安装命令并回退到同一 REST 端点（`/api/v3/aggTrades`） | ✅ **已集成：技能格式对齐 + `--skill` 通道真实调用 binance-cli** |
| [binance-connector-js](https://github.com/binance/binance-connector-js)<br>官方 JS/TS 连接器 | 用于调用 `api.binance.com`。**本机网络对该域名不可达**（连接被拦，`CONNECT tunnel failed`），装了也无法运行，因此未作为依赖引入；改走上面那个官方公开行情入口 | ⛔ 网络不可达，未引入 |
| [binance-connector-python](https://github.com/binance/binance-connector-python) | 官方 Python 连接器，同上（另一个域名的同一类接口），且本项目是 JS 技术栈 | ⛔ 与本项目技术栈不符 |
| [binance-futures-connector-python](https://github.com/binance/binance-futures-connector-python) | 永续的 Python 连接器，指向 `fapi.binance.com`（本机同样不可达） | ⛔ 同上 |
| [binance-api-postman](https://github.com/binance/binance-api-postman) | Postman 集合，用于手工调试接口；本项目用代码直接请求，未使用 | ⭕ 未使用（调试工具） |
| [binance-cli](https://github.com/binance/binance-cli)（官方技能 `binance` 驱动） | **`--skill` 通道的目标工具**：官方技能安装器装好 `binance-cli` 后，本作品直接调用 `binance-cli spot agg-trades`（Market 区块免密钥行情）取实时逐笔；本机未安装该工具时自动回退到等价的 `--live` 通道并打印官方安装命令 | ✅ 已集成（`--skill` 通道；本机无 CLI 时如实回退） |

**为什么行情分析不需要 API 密钥**：本作品的两条币安通道都走**公开数据入口**
（历史数据文件 + 公开行情接口），不涉及签名与账户权限。因此任何人都能零成本复现。

> 诚实说明：`api.binance.com` / `fapi.binance.com` 在本地网络下不可达（已实测），
> 所以本作品没有把官方连接器当作依赖引入 —— 引了也跑不起来。这不是「不用官方资源」，
> 而是选了官方专门为公开行情提供的入口。

---

## 三、Agent 的工作流

```text
用户/上层 Agent 提出需求（例：「看看 SOL 现在的成交结构」）
        │
        ▼
读取技能定义 skills/chengjiao-jiegou/SKILL.md   ← 遵循官方技能规范
        │  决定用哪条通道、传什么参数
        ▼
执行命令行入口  node agent.mjs SOL --official --window 20m
        │
        ├─ 通道一（历史，推荐）：官方公开数据
        │    data.binance.vision 下载 aggTrades ZIP
        │    → 流式解压（只保留窗口内记录，越过右边界立即掐断）
        │    → 归一化为 {ts, price, notional, dir}
        │
        ├─ 通道二（实时，现货）：官方公开行情接口
        │    data-api.binance.vision 轮询 aggTrades（1000 条/次，按成交编号去重）
        │    → 同一套归一化口径 → 与官方K线成交额对账算覆盖率
        │
        └─ 通道三（实时，多平台）：公开行情接口滚雪球
             读最近约 1000 条逐笔 → 每 2 秒轮询累积（支持永续与现货）
        │
        ▼
分析引擎（与网页版完全同一套代码）
        ├─ 自适应分档：中单线 = max(中位数×3, P75)；大单线 = max(中位数×10, P95)
        ├─ 十二个订单流特征量
        └─ 三态打分 → 取最高分 → 结论 + 证据 + 置信度
        │
        ▼
输出：文本报告（给人看）或 JSON（给程序解析）
```

---

## 四、安装与运行

### 4.1 作为技能装载（官方安装器）

```bash
# 装载本作品提供的技能
npx skills add https://github.com/JIEBAO100/chengjiao-jiegou-agent

# （可选）同时装载币安官方技能市场，用于账户/交易类需求
npx skills add https://github.com/binance/binance-skills-hub
```

### 4.2 直接运行（不需要任何密钥）

```bash
# 通道一：官方公开数据（历史，现货/永续都能用，一条命令出完整结论）
node agent.mjs BTC --official
node agent.mjs SOL --official --date 2026-09-11 --window 30m

# 通道二：币安官方公开行情接口（实时，现货）
node agent.mjs BTC --live --seconds 420

# 通道三：多平台公开行情（实时，支持永续与现货）
node agent.mjs BTC --seconds 420

# 自然语言 / JSON 输出
node agent.mjs "看看 SOL 现在的成交结构"
node agent.mjs BTC --official --json
```

环境要求：Node.js 18+（零第三方依赖）。

---

## 五、输出怎么解释（例：实测一次官方通道）

```text
成交结构拆解（分档线：中单 ≥ 1999　大单 ≥ 2.50 万）
  档位    成交额        占比     主动买        主动卖        净额
  大单    634.06 万     63.3%   328.61 万      305.44 万      +23.17 万
  中单    298.78 万     29.9%   145.07 万      153.70 万      -8.63 万
  小单    68.08 万      6.8%    31.46 万       36.63 万       -5.17 万

主力行为研判
  结论：结构模糊（置信度 80% · 领先优势 3 分）
  主力吃货 3　主力出货 17　散户乱交易 20
```

怎么读：

- **分档线是自适应的**（跟着该币种自己的成交分布走），所以不同币种的分档线金额不一样，这是设计而非异常
- 三条分数**取最高分**作为结论；领先不足 8 分判「结构模糊」——盘面确实没有清晰指向时就该这么说
- 结论切换有 10 分迟滞，避免输出来回跳
- 每次输出都附**支持证据与反对证据**，两边都列，不做选择性汇报

---

## 六、诚实边界与合规

- 本 Agent 描述的是**当期成交结构**，不是价格预测；「主力」是统计意义上的大额资金，不等于识别具体主体
- 样本不足时会明确输出「数据积累中」，不会用假数据或固定数值顶替
- 逐笔采集的缺口会被检测并标记（编号不连续），不会假装数据完整
- 只读取**公开数据**：不登录、不绑定、不需要也不接受 API 密钥、不执行任何交易操作
- 输出仅为数据统计结果，**不构成投资建议**

---

## 七、开发过程中的真实验证

| 测试 | 覆盖 | 规模 |
|---|---|---|
| `_test-core.mjs` | 分档阈值、三态判定（吸筹/出货/散户三种典型形态）、冷启动门槛、逐笔仓库、异常与离群值 | 33 项 |
| `_test-chart.mjs` | 图表绘制（K线与堆叠柱真的画出来、坐标无异常值） | 24 项 |
| `_test-server.mjs` | 接口与静态资源、访问控制、合规底线 | 44 项 |
| `_test-page.mjs` | 页面端到端：真实加载、搜索交互、面板渲染 | 42 项 |
| `_test-page-restore.mjs` | 本地缓存恢复后立即出结论 | 25 项 |

合计 **168 项**，与上传前的格式体检脚本（双模式各 15+ 项）一起构成交付前的自检。

自测中抓到并修复的真实缺陷（不是看代码看出来的）：分档阈值在双峰分布下让大单归零、
直方图口径系统性低估大单占比、**打分函数误用绝对值导致「大单占比越高越像散户」**、
页面调用未定义函数导致每次采集都抛错、成交结构时间轴因字段不匹配一根柱子都画不出来、
K线含异常值时静默丢图形、币种列表只加载前 200 个导致冷门币搜不到、默认周期过长导致结论要等一个多小时。
