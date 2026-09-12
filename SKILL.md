---
name: chengjiao-jiegou
description: 拆解任意币种的逐笔成交结构：把成交量按金额拆成大单/中单/小单，用十二个订单流特征研判当前盘面属于「主力真实吸筹 / 主力诱多出货 / 纯散户行情无主力」，并给出三条行为分数与支持/反对证据。数据来自 Binance 官方公开数据仓库（可选实时逐笔通道），不需要 API 密钥，不涉及任何交易操作。
metadata:
  version: 1.2.0
  author: JIEBAO100
  category: market-data-analysis
  official_resources:
    - https://github.com/binance/binance-public-data
    - https://github.com/binance/binance-skills-hub
    - https://github.com/binance/binance-spot-api-docs
  optional_skills:
    # 官方 binance 技能（Skills Hub）：--skill 通道会调用其驱动的 binance-cli（免密钥行情）；
    # 未安装时自动回退到等价的公开行情端点，不影响本技能使用
    - name: binance
      source: https://github.com/binance/binance-skills-hub
      usage: binance-cli spot agg-trades（Market 区块，无需鉴权）
  requires:
    bins:
      - node
license: MIT
---

# 成交结构拆解（chengjiao-jiegou）

看K线只能看到「价格走到了哪里」，看不到「这些成交是怎么打出来的」。

同样是上涨 2%，可能是主力在持续吸筹（真金白银在买，卖压被一点点吃掉），也可能是主力一边拉抬一边出货（散户在往上接）。这两种形态在价格图上几乎一模一样，在成交结构上却完全不同。本技能就是用来把这两者区分开的。

## 数据来源（官方公开入口，无需密钥）

本技能提供四条数据通道，全部使用**公开**数据、都不需要 API 密钥、都不涉及账户权限：

| 通道 | 官方来源 | 特点 |
|---|---|---|
| `--skill`（官方技能） | 官方技能市场 [binance/binance-skills-hub](https://github.com/binance/binance-skills-hub) 的 `binance` 技能：直接调用其驱动的命令行工具 `binance-cli spot agg-trades`（Market 区块，无需鉴权） | 实时逐笔（现货）；未安装 `binance-cli` 时自动回退到 `--live` 同一端点，并打印官方安装命令 |
| `--official`（历史，推荐） | [binance/binance-public-data](https://github.com/binance/binance-public-data) → `data.binance.vision` 的每日 aggTrades 文件 | 历史完整，**一条命令立刻出完整结论**；现货与永续都支持 |
| `--live`（实时，现货） | [binance/binance-spot-api-docs](https://github.com/binance/binance-spot-api-docs) 记载的公开行情入口 `data-api.binance.vision` | 读官方实时逐笔（aggTrades）、K线与 24 小时行情；仅现货。与官方技能 `agg-trades` 命令是**同一 REST 端点** |
| 默认（实时，多平台） | 多平台公开行情接口最近约 1000 条逐笔 | 每 2 秒轮询「滚雪球」，支持永续与现货 |

需要账户或交易类能力时，可另外装载官方技能市场
（`npx skills add https://github.com/binance/binance-skills-hub`），本技能不与之冲突。

## 什么时候用这个技能

在下面这些情况下调用它：

- 用户问某个币「现在是主力在买还是在卖」「这波涨是散户推的还是主力推的」
- 用户想知道盘面属于吸筹、出货还是纯散户行情
- 用户想看大单 / 中单 / 小单的成交占比与净额
- 用户想核对「价格在涨但资金在流出」这类背离现象

不要在下面这些情况下用它：用户要求下单/交易（本技能只读公开行情，不能下单）、用户要求预测未来价格（本技能只描述当期成交结构，不做预测）。

## 前置条件

- 需要 Node.js 18 或更高版本（无第三方依赖，不需要 API 密钥）
- 需要能访问交易所公开行情接口的网络环境

## 怎么运行

本技能就是一条命令，在技能所在项目的根目录执行：

```sh
node agent.mjs <币种> [周期] [--seconds 采集秒数] [--official] [--json]
```

常用示例：

```sh
# 官方技能通道：调用官方 binance 技能的 binance-cli（未安装时自动回退并给安装命令）
node agent.mjs BTC --skill --seconds 420

# 官方公开数据通道（推荐：历史数据现成，一条命令出完整结论，无需等待）
node agent.mjs BTC --official
node agent.mjs SOL --official --date 2026-09-11 --window 30m

# 币安官方公开行情接口（实时，现货）
node agent.mjs BTC --live --seconds 420

# 多平台实时逐笔通道（支持永续与现货，需要积累时间）
node agent.mjs ETH 5m --seconds 420

# 自然语言也可以
node agent.mjs "看看 SOL 现在的成交结构"

# 现货市场 / 永续合约
node agent.mjs BTC --spot
node agent.mjs BTC --perp

# 输出 JSON，便于程序解析
node agent.mjs BTC --official --json

# 查看本地已积累了多少数据；清空积累
node agent.mjs --status
node agent.mjs --reset
```

参数说明：

| 参数 | 含义 |
|---|---|
| `<币种>` | 币种代号，如 `BTC`、`ETH`、`SOL`；也可写 `BTC_USDT` / `BTC/USDT` |
| `[周期]` | `1m` / `5m` / `15m` / `30m` / `1h` / `4h`，默认 `1m` |
| `--skill` | 官方技能通道：调用官方 `binance` 技能驱动的 `binance-cli`（Market 区块免密钥行情）；未安装时回退到 `--live` 同一端点 |
| `--official` | 使用官方公开数据通道（历史文件，**推荐**，不需要本地积累） |
| `--live` | 使用币安官方公开行情接口（实时，仅现货；会自动切到现货市场） |
| `--date YYYY-MM-DD` | 官方通道的分析日期（UTC），默认自动取最近一个已发布文件的日期 |
| `--at HH:MM` | 官方通道窗口的结束时刻（UTC），默认 `23:59` |
| `--window 30m` | 官方通道的窗口长度，默认 `60m`（可写 `30m` / `2h` / `90`） |
| `--seconds N` | 实时/技能通道的采集秒数（默认 30，最大 1800） |
| `--json` | 输出 JSON（进度信息写到 stderr，stdout 只有 JSON） |
| `--spot` / `--perp` | 现货 / 永续合约（默认永续） |
| `--status` / `--reset` | 查看或清空本地积累 |

### 四条通道怎么选

| 场景 | 用哪条 | 命令 |
|---|---|---|
| 已按官方技能装好 binance-cli，想走官方工具 | **官方技能** | `node agent.mjs BTC --skill --seconds 420` |
| 想立刻拿到完整结论 | **官方公开数据** | `node agent.mjs BTC --official` |
| 想分析某个历史时段 | 官方公开数据 | `node agent.mjs BTC --official --date 2026-09-11 --window 2h` |
| 想看此刻的现货结构，且要官方数据 | 官方公开行情接口 | `node agent.mjs BTC --live --seconds 420` |
| 想看此刻的永续结构 | 多平台实时逐笔 | `node agent.mjs BTC --seconds 420` |

### 关于「为什么实时通道需要采集一段时间」

公开行情接口只给最近约 1000 条逐笔成交，没有历史翻页。结构类结论需要足够的样本（≥300 笔）与若干个**已完结**的时间桶（≥6 个），所以实时通道会每 2 秒轮询一次、按成交编号去重后「滚雪球」积累。

- 1 分钟档：建议 `--seconds 400` 以上（约 7 分钟），可拿到完整结论
- 更长的周期需要更久：5 分钟档建议 30 分钟以上
- 积累的数据会写到项目根目录的 `.cjx-agent-state.json`，**下次运行会继续累加**，不必一次跑完
- 如果只跑 30 秒，通常会得到「数据积累中」——这是诚实的结果，不是故障

**官方公开数据通道没有这个问题**：历史文件里记录是完整的，窗口内的样本全部可用，一条命令即可出结论。

## 输出怎么读

文本模式输出四块内容：

1. **行情摘要** —— 最新价、24 小时涨跌、24 小时成交额
2. **数据质量** —— 累计样本数、已完结时间桶数、覆盖率（与K线成交额对账）、采集缺口
3. **成交结构拆解** —— 大单 / 中单 / 小单各自的成交额、占比、主动买、主动卖、净额，以及当前使用的分档线金额
4. **主力行为研判** —— 结论、置信度、领先优势、三条行为分数、支持证据与反对证据

JSON 模式（`--json`）的关键字段：

| 字段 | 说明 |
|---|---|
| `ok` | 是否给出了完整结论（false 表示数据积累中） |
| `source` | 数据通道：`official`（官方公开数据）或 `realtime`（实时逐笔） |
| `dataUrl` / `window` | 官方通道实际下载的文件地址与 UTC 时间窗（便于复核） |
| `verdict` / `verdictKey` | 结论中文名 / 机器可读键：`accum`（主力真实吸筹）、`distrib`（主力诱多出货）、`retail`（纯散户行情无主力）、`fuzzy`（结构模糊）、`pending`（数据积累中） |
| `scores` | 三条行为分数（0–100）：`accum` 主力吃货、`distrib` 主力出货、`retail` 散户乱交易 |
| `tiers` | 三档拆解：每档的 `total` / `buy` / `sell` / `net` / `share` / 笔数 |
| `thresholds` | 本次使用的分档线金额（`mid` 中单线、`large` 大单线） |
| `confidence` | 置信度（一半看样本积累进度，一半看采集覆盖率） |
| `evidence.support` / `evidence.against` | 支持证据 / 反对证据 |
| `samples` / `bucketsClosed` / `coverage` | 样本数 / 已完结时间桶数 / 覆盖率 |

退出码：`0` 表示给出了完整结论，`2` 表示数据积累中（需要继续采集），`1` 表示取数失败。

## 算法口径（回答用户追问时要能解释清楚）

### 大小单分档（自适应，不能写死金额）

```text
中单线 = max(单笔成交额中位数 × 3, P75)
大单线 = max(单笔成交额中位数 × 10, P95)
两条线至少拉开 2 倍；阈值做 EMA 平滑（系数 0.2）
```

为什么不能写死金额：1 万美元的 BTC 单是小单，放到冷门币上就是巨单。阈值必须跟着**该币种自己的成交分布**走。

为什么中单线用 P75 而不是更高分位：币圈成交分布常见「海量碎单 + 少量大单」的双峰形态，中单线若用 P95 会被直接顶到大单量级，结果所有大单都掉进中单、大单占比恒为 0，吸筹与出货结论就永远出不来。

### 十二个订单流特征量

大单净流入占比、大单成交占比、主动方向纯度、价格冲击弹性、时间集中度、大单占比漂移、大小单背离、散户追涨度、资金与价格背离、小单主导度、节奏稳定性、中单占比。

### 三态判定规则

| 结论 | 典型证据 |
|---|---|
| 主力真实吸筹 | 大单净买；买盘吸收顺畅（同样成交只推动很小价格变化）；资金在时间上扎堆；大单在吸、小单在抛 |
| 主力诱多出货 | 价格在涨、大单却净卖；散户追涨明显；大单派发、小单接盘 |
| 纯散户行情无主力 | 大单占比低；成交额主要来自碎单；大单买卖基本均衡、无清晰方向 |

判定细则：

- 三种行为各打 0–100 分，**取最高分**作为结论
- 领先不足 8 分 → 「结构模糊」（宁可说不知道，也不硬给结论）
- 样本不足 300 笔、或已完结时间桶少于 6 个 → 「数据积累中」
- 结论切换有 10 分迟滞，避免结果来回跳
- 分档阈值与用户网页版完全一致，两处结果不会互相打架

### 诚实边界（回答用户时必须如实转达）

- 本技能描述的是**当期成交结构**，不是价格预测
- 「主力」是统计意义上的大额资金（依据成交金额分布与订单流特征），不等于识别出某个具体主体
- 逐笔样本是滚雪球积累的：刚启动时样本不足，会明确显示「数据积累中」
- 接口失败或超时时给出明确的中文失败原因，**不会用演示数据或固定数值顶替**
- 采集缺口会被如实标记（编号不连续），不会假装数据完整

## 安全与合规

- 只读取交易所**公开行情数据**，不登录、不绑定、不读取任何账户信息
- 不需要也不接受任何 API 密钥
- **不执行任何交易操作**，没有下单能力
- 输出仅为数据统计结果，不构成投资建议。转达给用户时应保留这一声明。
