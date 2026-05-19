# Wolfcha 狼人杀前端项目技术架构分析

> 本文档详细分析 Wolfcha（AI 驱动狼人杀游戏）的事件发布机制、UI 订阅机制、场景切换逻辑，以及所有游戏事件和 UI 组件的完整枚举。

---

## 一、核心架构概览

### 1.1 技术栈
- **框架**: Next.js 16 (App Router)
- **状态管理**: Jotai (原子化状态管理)
- **动画**: Framer Motion
- **样式**: Tailwind CSS + CSS 变量
- **AI 代理**: 通过 `/api/chat` 路由代理到 ZenMux / Dashscope / NewAPI

### 1.2 关键架构决策：无传统 Pub/Sub 事件总线

**本项目不使用传统的事件发布/订阅模式（如 EventEmitter、PubSub、WebSocket 事件等）。**

相反，它采用 **"状态即事件"** 的架构：
- **发布事件** = 调用 `setGameState()` 修改中央 `GameState` 对象
- **订阅事件** = React 组件通过 `useAtom(gameStateAtom)` 或 props 接收 `gameState`，当状态变化时自动重渲染

这种架构的核心优势是简单、可预测、可持久化（localStorage  Checkpoint 恢复）。

---

## 二、事件发布机制详解

### 2.1 中央状态：`GameState`

定义位置: [`src/types/game.ts`](src/types/game.ts)

`GameState` 是单一事实来源（Single Source of Truth），所有游戏事件都通过修改这个对象来"发布"。

关键状态字段：

```typescript
interface GameState {
  gameId: string;
  phase: Phase;                    // 当前阶段
  day: number;                     // 第几天
  players: Player[];               // 所有玩家
  messages: ChatMessage[];         // 聊天/系统消息日志
  votes: Record<string, number>;   // 投票记录 {voterId -> targetSeat}
  voteReasons?: Record<string, string>;
  badge: {                         // 警徽状态
    holderSeat: number | null;
    candidates: number[];
    signup: Record<string, boolean>;
    votes: Record<string, number>;
    allVotes: Record<string, number>;
    history: Record<number, Record<string, number>>;
    revoteCount: number;
  };
  nightActions: {                  // 夜间动作记录
    guardTarget?: number;
    lastGuardTarget?: number;
    wolfVotes?: Record<string, number>;
    wolfTarget?: number;
    witchSave?: boolean;
    witchPoison?: number;
    seerTarget?: number;
    seerResult?: { targetSeat: number; isWolf: boolean };
    seerHistory?: Array<{ targetSeat: number; isWolf: boolean; day: number }>;
    pendingWolfVictim?: number;
    pendingPoisonVictim?: number;
  };
  nightHistory?: Record<number, NightRecord>;  // 按天记录的夜晚历史
  dayHistory?: Record<number, DayRecord>;      // 按天记录的白天历史
  roleAbilities: {                 // 角色能力使用状态
    witchHealUsed: boolean;
    witchPoisonUsed: boolean;
    hunterCanShoot: boolean;
    idiotRevealed: boolean;
    whiteWolfKingBoomUsed: boolean;
  };
  winner: Alignment | null;
  // ... 其他字段
}
```

### 2.2 状态修改即事件发布

所有游戏事件都通过以下模式发布：

#### 模式 1：直接状态替换（最常用）
```typescript
// 来自 useGameLogic.ts / useSpecialEvents.ts / useBadgePhase.ts
setGameState((prevState) => ({
  ...prevState,
  nightActions: {
    ...prevState.nightActions,
    wolfTarget: targetSeat,
    wolfVotes: wolfVotes,
  },
}));
```

#### 模式 2：通过游戏主控函数修改
定义位置: [`src/lib/game-master.ts`](src/lib/game-master.ts)

```typescript
// 纯函数式状态转换
export function transitionPhase(state: GameState, phase: Phase): GameState { ... }
export function killPlayer(state: GameState, seat: number): GameState { ... }
export function addSystemMessage(state: GameState, content: string): GameState { ... }
export function checkWinCondition(state: GameState): Alignment | null { ... }
export function tallyVotes(state: GameState): { seat: number; count: number } | null { ... }
```

#### 模式 3：AI 动作生成
定义位置: [`src/lib/game-master.ts`](src/lib/game-master.ts)

```typescript
export async function generateWolfAction(state: GameState, player: Player, options: {...}): Promise<number> { ... }
export async function generateWitchAction(state: GameState, player: Player): Promise<WitchAction> { ... }
export async function generateSeerAction(state: GameState, player: Player): Promise<number> { ... }
export async function generateGuardAction(state: GameState, player: Player): Promise<number> { ... }
export async function generateHunterShoot(state: GameState, player: Player): Promise<number | null> { ... }
export async function generateAIVote(state: GameState, player: Player): Promise<{ seat: number; reason: string }> { ... }
export async function generateAISpeechStream(...): Promise<ReadableStream> { ... }
```

### 2.3 各核心事件的发布流程

#### 2.3.1 狼人刀人 (Werewolf Kill)

**代码路径**: [`src/game/phases/NightPhase.ts`](src/game/phases/NightPhase.ts) → [`src/hooks/useGameLogic.ts`](src/hooks/useGameLogic.ts)

流程：
1. `NightPhase.runWolfAction()` 进入 `NIGHT_WOLF_ACTION` 阶段
2. 如果人类玩家是狼人：等待人类选择目标（通过 UI 点击）
3. 如果全是 AI 狼人：`generateWolfAction()` 生成目标
4. 状态更新：
   ```typescript
   currentState = {
     ...currentState,
     nightActions: {
       ...currentState.nightActions,
       wolfVotes: { [wolf1Id]: targetSeat, [wolf2Id]: targetSeat, ... },
       wolfTarget: targetSeat,
     },
   };
   ```
5. 通过 `setGameState(currentState)` 发布事件

#### 2.3.2 女巫救人/毒人 (Witch Save/Poison)

**代码路径**: [`src/game/phases/NightPhase.ts`](src/game/phases/NightPhase.ts)

流程：
1. `NightPhase.runWitchAction()` 进入 `NIGHT_WITCH_ACTION` 阶段
2. 如果人类玩家是女巫：显示 Witch Action Panel（救/毒/过）
3. 如果 AI 女巫：`generateWitchAction()` 决策
4. 状态更新：
   ```typescript
   // 救人
   { nightActions: { ...prev, witchSave: true }, roleAbilities: { ...prev, witchHealUsed: true } }
   // 毒人
   { nightActions: { ...prev, witchPoison: targetSeat }, roleAbilities: { ...prev, witchPoisonUsed: true } }
   // 跳过
   { nightActions: { ...prev, witchSave: false } }
   ```

#### 2.3.3 预言家查验 (Seer Check)

**代码路径**: [`src/game/phases/NightPhase.ts`](src/game/phases/NightPhase.ts)

流程：
1. `NightPhase.runSeerAction()` 进入 `NIGHT_SEER_ACTION` 阶段
2. 人类预言家选择目标 → `handleNightAction(targetSeat)`
3. 状态更新：
   ```typescript
   {
     nightActions: {
       ...prev,
       seerTarget: targetSeat,
       seerResult: { targetSeat, isWolf: isWolfRole(targetPlayer.role) },
       seerHistory: [...(prev.seerHistory || []), { targetSeat, isWolf, day: prev.day }],
     },
   }
   ```

#### 2.3.4 守卫保护 (Guard Protect)

**代码路径**: [`src/game/phases/NightPhase.ts`](src/game/phases/NightPhase.ts)

流程：
1. `NightPhase.runGuardAction()` 进入 `NIGHT_GUARD_ACTION` 阶段
2. 人类守卫选择目标
3. 状态更新：
   ```typescript
   { nightActions: { ...prev, guardTarget: targetSeat } }
   ```

#### 2.3.5 投票 (Voting)

**代码路径**: [`src/game/phases/VotePhase.ts`](src/game/phases/VotePhase.ts)

流程：
1. `VotePhase.onEnter()` 进入 `DAY_VOTE` 阶段，初始化 `votes: {}`
2. AI 玩家循环投票：`generateAIVote()` → 更新 `votes[aiPlayerId] = vote.seat`
3. 人类玩家通过 UI 点击投票 → `handleHumanVote(targetSeat)`
4. 状态更新：
   ```typescript
   setGameState((prev) => ({
     ...prev,
     votes: { ...prev.votes, [playerId]: targetSeat },
     voteReasons: { ...(prev.voteReasons || {}), [playerId]: reason },
   }));
   ```
5. `VotePhase.resolveVotes()` 计票：`tallyVotes(state)`
6. 结果写入 `dayHistory[day] = { executed: { seat, votes }, voteTie: false }`

#### 2.3.6 警长竞选 (Badge Election)

**代码路径**: [`src/hooks/game-phases/useBadgePhase.ts`](src/hooks/game-phases/useBadgePhase.ts)

流程：
1. `startBadgeSignupPhase()` → `DAY_BADGE_SIGNUP`
2. 玩家报名：`badge.signup[playerId] = true/false`
3. `startBadgeSpeechPhase()` → `DAY_BADGE_SPEECH`
4. `startBadgeElectionPhase()` → `DAY_BADGE_ELECTION`
5. AI 投票：`generateAIBadgeVote()` → `badge.votes[aiPlayerId] = targetSeat`
6. `maybeResolveBadgeElection()` 计票，处理平票 PK

#### 2.3.7 猎人开枪 (Hunter Shoot)

**代码路径**: [`src/hooks/game-phases/useSpecialEvents.ts`](src/hooks/game-phases/useSpecialEvents.ts)

流程：
1. `handleHunterDeath()` → `HUNTER_SHOOT` 阶段
2. 人类猎人选择目标（或跳过）
3. AI 猎人：`generateHunterShoot()` → 可能返回 `targetSeat` 或 `null`
4. 如果开枪：`killPlayer(currentState, targetSeat)`
5. 记录到 `dayHistory` 或 `nightHistory` 的 `hunterShot` 字段

#### 2.3.8 白狼王自爆 (White Wolf King Boom)

**代码路径**: [`src/hooks/useGameLogic.ts`](src/hooks/useGameLogic.ts)

流程：
1. 白天发言阶段检查：`generateWhiteWolfKingBoomDecision()`
2. 如果自爆：进入 `WHITE_WOLF_KING_BOOM` 阶段
3. 选择带人目标：`generateWhiteWolfKingBoomTarget()`
4. `killPlayer()` 处理死亡
5. 记录到 `dayHistory[day].whiteWolfKingBoom`

#### 2.3.9 夜晚结算 (Night Resolve)

**代码路径**: [`src/hooks/game-phases/useSpecialEvents.ts`](src/hooks/game-phases/useSpecialEvents.ts) → `resolveNight()`

流程：
1. 进入 `NIGHT_RESOLVE` 阶段
2. 判定狼人击杀：
   - 守卫保护 + 女巫不救 = 死（同守同救/奶穿）
   - 守卫保护 + 女巫救 = 死（奶穿）
   - 无保护 + 女巫救 = 活
   - 无保护 + 女巫不救 = 死
3. 判定女巫毒杀
4. 更新状态：
   ```typescript
   {
     nightActions: {
       ...prev,
       lastGuardTarget: guardTarget,
       pendingWolfVictim: wolfKillSuccessful ? wolfVictimSeat : undefined,
       pendingPoisonVictim: poisonVictimSeat,
     },
     nightHistory: {
       ...prev.nightHistory,
       [day]: { guardTarget, wolfTarget, witchSave, witchPoison, seerTarget, seerResult, deaths },
     },
   }
   ```
5. 过渡到 `DAY_START`

#### 2.3.10 游戏结束 (Game End)

**代码路径**: [`src/hooks/game-phases/useSpecialEvents.ts`](src/hooks/game-phases/useSpecialEvents.ts) → `endGame()`

流程：
1. `checkWinCondition()` 检测到某方胜利
2. 进入 `GAME_END` 阶段
3. 设置 `winner: "village" | "wolf"`
4. 添加系统消息：`[ROLE_REVEAL]${JSON.stringify({...})}`
5. 调用 `gameSessionTracker.end(winnerType, true)` 同步到数据库

---

## 三、UI 订阅机制详解

### 3.1 Jotai 原子订阅

定义位置: [`src/store/game-machine.ts`](src/store/game-machine.ts)

```typescript
export const gameStateAtom = atom(
  (get) => get(rawGameStateAtom),
  (get, set, update: GameState | ((prev: GameState) => GameState)) => {
    const next = typeof update === "function" ? update(prev) : update;
    set(rawGameStateAtom, next);
    saveGameState(next);  // 持久化到 localStorage
  }
);

export const uiStateAtom = atom({
  isLoading: false,
  isWaitingForAI: false,
  showTable: false,
  selectedSeat: null,
  showRoleReveal: false,
  showLog: false,
});

export const dialogueAtom = atom<DialogueState | null>(null);
```

### 3.2 订阅层级

#### 层级 1：根页面订阅所有状态
**文件**: [`src/app/page.tsx`](src/app/page.tsx)

```typescript
const {
  gameState, isLoading, isWaitingForAI, currentDialogue,
  showTable, humanPlayer, isNight,
  // ... 各种 handlers
} = useGameLogic();
```

`page.tsx` 订阅完整的 `gameState`，然后根据状态决定渲染什么 UI。

#### 层级 2：子组件通过 props 接收状态
大部分游戏 UI 组件不直接连接 Jotai，而是通过 props 从 `page.tsx` 接收：

```typescript
// page.tsx 中
<DialogArea
  gameState={gameState}
  currentDialogue={currentDialogue}
  displayedText={displayedText}
  isTyping={isTyping}
  isHumanTurn={isHumanTurn}
  // ...
/>

<PlayerCardCompact
  player={player}
  isSpeaking={isSpeaking}
  canClick={canClick}
  isSelected={isSelected}
  seerCheckResult={seerCheckResult}
  // ...
/>
```

#### 层级 3：独立 UI 状态订阅
**文件**: [`src/components/game/WelcomeScreen.tsx`](src/components/game/WelcomeScreen.tsx)

WelcomeScreen 中的模态框、设置等使用本地 React state，不直接订阅 gameState。

### 3.3 场景切换的核心逻辑

场景切换不是通过路由，而是通过 **条件渲染** 基于 `gameState.phase` 和 `showTable`：

```typescript
// page.tsx 中的核心渲染逻辑
if (!gameStarted || !showTable) {
  return <WelcomeScreen ... />;
}

// 已进入游戏
return (
  <>
    <GameBackground isNight={visualIsNight} isBlinking={!!dayNightBlinkPhase} />
    {/* 玩家桌面板 */}
    <div className="wc-table-grid">
      {gameState.players.map((player) => (
        <PlayerCardCompact ... />
      ))}
    </div>
    {/* 对话区 */}
    <DialogArea ... />
    {/* 底部操作面板 */}
    <BottomActionPanel ... />
    {/* 各种 Overlay */}
    <RoleRevealOverlay ... />
    <NightActionOverlay ... />
    <TutorialOverlay ... />
    {/* ... */}
  </>
);
```

### 3.4 日夜场景切换

**文件**: [`src/app/page.tsx`](src/app/page.tsx)

```typescript
const [visualIsNight, setVisualIsNight] = useState(isNight);
const [dayNightBlinkPhase, setDayNightBlinkPhase] = useState<null | "closing" | "opening">(null);
```

切换机制：
1. `useGameLogic()` 根据 `gameState.phase` 计算 `isNight`
2. `page.tsx` 监听 `isNight` 变化
3. 切换到夜晚时：先显示 "天黑请闭眼" Ritual Cue，然后触发眨眼动画（closing → 切换背景 → opening）
4. `GameBackground` 组件根据 `isNight` 渐变切换 CSS 背景和氛围光效
5. BGM 同步切换：`day.mp3` ↔ `night.mp3`，带淡入淡出效果

### 3.5 夜间动作视觉反馈订阅

**文件**: [`src/app/page.tsx`](src/app/page.tsx) 第 540~560 行附近

```typescript
useEffect(() => {
  const { wolfTarget, witchSave, witchPoison, seerTarget } = gameState.nightActions;
  const last = lastNightActionRef.current;

  // 狼人看到刀人目标
  if (canSeeWolf && typeof wolfTarget === "number" && wolfTarget !== last.wolfTarget) {
    triggerNightOverlay("wolf", wolfTarget);
  }
  // 女巫看到救人
  if (canSeeWitch && witchSave && witchSave !== last.witchSave) {
    triggerNightOverlay("witch-save", wolfTarget);
  }
  // ... 预言家查验、猎人开枪等

  lastNightActionRef.current = { wolfTarget, witchSave, witchPoison, seerTarget };
}, [gameState.nightActions, humanPlayer, ...]);
```

这是典型的"订阅模式"：监听 `gameState.nightActions` 的变化，当特定字段改变时触发视觉 Overlay。

### 3.6 仪式提示 (Ritual Cue) 订阅

**文件**: [`src/app/page.tsx`](src/app/page.tsx)

```typescript
useEffect(() => {
  const lastSystem = [...gameState.messages].reverse().find((m) => m.isSystem);
  if (!lastSystem) return;
  const cue = getRitualCueFromSystemMessage(lastSystem.content);
  if (!cue) return;
  setRitualCue({ id: lastSystem.id, title: cue.title, subtitle: cue.subtitle });
}, [gameState.messages]);
```

系统消息（如"天黑了"、"守卫请睁眼"）被解析为仪式提示，显示在屏幕中央。

---

## 四、所有游戏事件（Phase）完整枚举

定义位置: [`src/types/game.ts`](src/types/game.ts)

### 4.1 阶段类型：`Phase`

| Phase 值 | 中文说明 | 对应逻辑文件 |
|---------|---------|------------|
| `LOBBY` | 大厅/等待 | [`src/app/page.tsx`](src/app/page.tsx) |
| `SETUP` | 游戏设置/初始化 | [`src/lib/game-master.ts`](src/lib/game-master.ts) |
| `NIGHT_START` | 夜晚开始 | [`src/game/phases/NightPhase.ts`](src/game/phases/NightPhase.ts) |
| `NIGHT_GUARD_ACTION` | 守卫行动 | [`src/game/phases/NightPhase.ts`](src/game/phases/NightPhase.ts) |
| `NIGHT_WOLF_ACTION` | 狼人行动（刀人） | [`src/game/phases/NightPhase.ts`](src/game/phases/NightPhase.ts) |
| `NIGHT_WITCH_ACTION` | 女巫行动（救/毒） | [`src/game/phases/NightPhase.ts`](src/game/phases/NightPhase.ts) |
| `NIGHT_SEER_ACTION` | 预言家行动（查验） | [`src/game/phases/NightPhase.ts`](src/game/phases/NightPhase.ts) |
| `NIGHT_RESOLVE` | 夜晚结算 | [`src/hooks/game-phases/useSpecialEvents.ts`](src/hooks/game-phases/useSpecialEvents.ts) |
| `DAY_START` | 天亮 | [`src/hooks/game-phases/useSpecialEvents.ts`](src/hooks/game-phases/useSpecialEvents.ts) |
| `DAY_BADGE_SIGNUP` | 警徽竞选报名 | [`src/hooks/game-phases/useBadgePhase.ts`](src/hooks/game-phases/useBadgePhase.ts) |
| `DAY_BADGE_SPEECH` | 警徽竞选发言 | [`src/hooks/game-phases/useBadgePhase.ts`](src/hooks/game-phases/useBadgePhase.ts) |
| `DAY_BADGE_ELECTION` | 警徽评选投票 | [`src/hooks/game-phases/useBadgePhase.ts`](src/hooks/game-phases/useBadgePhase.ts) |
| `DAY_PK_SPEECH` | PK 发言（平票后） | [`src/game/phases/DaySpeechPhase.ts`](src/game/phases/DaySpeechPhase.ts) |
| `DAY_SPEECH` | 白天发言 | [`src/game/phases/DaySpeechPhase.ts`](src/game/phases/DaySpeechPhase.ts) |
| `DAY_LAST_WORDS` | 遗言 | [`src/game/phases/DaySpeechPhase.ts`](src/game/phases/DaySpeechPhase.ts) |
| `DAY_VOTE` | 投票阶段 | [`src/game/phases/VotePhase.ts`](src/game/phases/VotePhase.ts) |
| `DAY_RESOLVE` | 白天结算 | [`src/game/phases/VotePhase.ts`](src/game/phases/VotePhase.ts) |
| `BADGE_TRANSFER` | 警长移交警徽 | [`src/hooks/game-phases/useBadgePhase.ts`](src/hooks/game-phases/useBadgePhase.ts) |
| `HUNTER_SHOOT` | 猎人开枪 | [`src/hooks/game-phases/useSpecialEvents.ts`](src/hooks/game-phases/useSpecialEvents.ts) |
| `WHITE_WOLF_KING_BOOM` | 白狼王自爆 | [`src/hooks/useGameLogic.ts`](src/hooks/useGameLogic.ts) |
| `GAME_END` | 游戏结束 | [`src/hooks/game-phases/useSpecialEvents.ts`](src/hooks/game-phases/useSpecialEvents.ts) |

### 4.2 游戏事件类型：`GameEventType`

定义位置: [`src/types/game.ts`](src/types/game.ts)

```typescript
type GameEventType =
  | "GAME_START"
  | "ROLE_ASSIGNED"
  | "PHASE_CHANGED"
  | "CHAT_MESSAGE"
  | "SYSTEM_MESSAGE"
  | "NIGHT_ACTION"
  | "VOTE_CAST"
  | "PLAYER_DIED"
  | "GAME_END";
```

这些事件存储在 `GameState.events` 数组中，主要用于历史记录，不驱动 UI 渲染。

### 4.3 游戏动作类型：`GameAction`

定义位置: [`src/game/core/types.ts`](src/game/core/types.ts)

```typescript
type GameAction =
  | { type: "START_NIGHT" }
  | { type: "CONTINUE_NIGHT_AFTER_GUARD" }
  | { type: "CONTINUE_NIGHT_AFTER_WOLF" }
  | { type: "CONTINUE_NIGHT_AFTER_WITCH" }
  | { type: "START_DAY_SPEECH_AFTER_BADGE"; options?: { skipAnnouncements?: boolean } }
  | { type: "ADVANCE_SPEAKER" }
  | { type: "RESOLVE_VOTES" }
  | { type: "VOTE"; targetSeat: number }
  | { type: "NIGHT_ACTION"; targetSeat: number; witchAction?: "save" | "poison" | "pass" }
  | { type: "CUSTOM"; payload: unknown };
```

### 4.4 阶段配置：`PHASE_CONFIGS`

定义位置: [`src/store/game-machine.ts`](src/store/game-machine.ts)

每个阶段的配置定义了：
- `requiresHumanInput`: 是否需要人类玩家输入
- `canSelectPlayer`: 是否可以选择玩家
- `actionType`: 动作类型
- `isNight`: 是否夜晚阶段

---

## 五、所有 UI 组件完整枚举

### 5.1 页面级组件

| 组件 | 文件路径 | 说明 |
|-----|---------|-----|
| `Home` (默认导出) | [`src/app/page.tsx`](src/app/page.tsx) | 主页面，订阅所有游戏状态，条件渲染 WelcomeScreen 或游戏界面 |

### 5.2 游戏主界面组件

| 组件 | 文件路径 | 说明 |
|-----|---------|-----|
| `GameBackground` | [`src/components/game/GameBackground.tsx`](src/components/game/GameBackground.tsx) | 游戏背景，根据 `isNight` 切换日夜渐变背景、角纹装饰、氛围光效 |
| `PlayerCardCompact` | [`src/components/game/PlayerCardCompact.tsx`](src/components/game/PlayerCardCompact.tsx) | 紧凑玩家卡片，显示头像、名字、座位号、死亡状态、发言指示器、狼队标记、查验结果、警徽标记 |
| `DialogArea` | [`src/components/game/DialogArea.tsx`](src/components/game/DialogArea.tsx) | 中央对话区，显示聊天历史、当前说话者头像、打字机效果、操作面板（女巫、投票等）、人类输入框 |
| `BottomActionPanel` | [`src/components/game/BottomActionPanel.tsx`](src/components/game/BottomActionPanel.tsx) | 底部操作面板，确认选择（投票、查验、刀人、守护、开枪、自爆）、女巫动作（救/毒/过）、猎人跳过 |
| `Notebook` | [`src/components/game/Notebook.tsx`](src/components/game/Notebook.tsx) | 笔记本组件，localStorage 持久化的文本笔记 |

### 5.3 覆盖层组件 (Overlays)

| 组件 | 文件路径 | 说明 |
|-----|---------|-----|
| `RoleRevealOverlay` | [`src/components/game/RoleRevealOverlay.tsx`](src/components/game/RoleRevealOverlay.tsx) | 角色揭示覆盖层，翻牌动画显示玩家角色、能力、提示 |
| `NightActionOverlay` | [`src/components/game/NightActionOverlay.tsx`](src/components/game/NightActionOverlay.tsx) | 夜间动作视觉反馈覆盖层（狼爪、治疗光环、毒雾、猎人闪光、预言家之眼） |
| `TutorialOverlay` | [`src/components/game/TutorialOverlay.tsx`](src/components/game/TutorialOverlay.tsx) | 教程覆盖层，显示夜晚/白天介绍、角色教程 |
| `SettingsModal` | [`src/components/game/SettingsModal.tsx`](src/components/game/SettingsModal.tsx) | 设置模态框，BGM 音量、音效开关、AI 语音开关、日志导出、退出游戏 |

### 5.4 投票相关组件

| 组件 | 文件路径 | 说明 |
|-----|---------|-----|
| `VotingProgress` | [`src/components/game/VotingProgress.tsx`](src/components/game/VotingProgress.tsx) | 投票进度面板，显示投票进度条、各目标得票数、投票者列表、未投票玩家 |
| `VoteResultCard` | [`src/components/game/VoteResultCard.tsx`](src/components/game/VoteResultCard.tsx) | 投票结果卡片，解析 `[VOTE_RESULT]` 系统消息显示结构化投票结果 |

### 5.5 狼人专用组件

| 组件 | 文件路径 | 说明 |
|-----|---------|-----|
| `WolfPlanningPanel` | [`src/components/game/WolfPlanningPanel.tsx`](src/components/game/WolfPlanningPanel.tsx) | 狼人策划面板，显示狼队友状态、投票意向、是否达成一致 |

### 5.6 玩家相关组件

| 组件 | 文件路径 | 说明 |
|-----|---------|-----|
| `PlayerDetailModal` | [`src/components/game/PlayerDetailModal.tsx`](src/components/game/PlayerDetailModal.tsx) | 玩家详情模态框，点击玩家卡片弹出，显示角色（如可见）、性格标签、MBTI、背景、说话风格 |
| `TalkingAvatar` | [`src/components/game/TalkingAvatar.tsx`](src/components/game/TalkingAvatar.tsx) | 会动的头像组件，根据 `isTalking` 切换嘴型动画，支持预加载 |
| `TalkingAvatarSmall` | [`src/components/game/TalkingAvatar.tsx`](src/components/game/TalkingAvatar.tsx) | 小版本 TalkingAvatar，用于聊天记录 |

### 5.7 日志组件

| 组件 | 文件路径 | 说明 |
|-----|---------|-----|
| `EventLog` | [`src/components/game/EventLog.tsx`](src/components/game/EventLog.tsx) | 事件日志面板，按天分组显示夜晚死亡、处决、平票、猎人开枪、白狼王自爆、白痴翻牌、游戏结束 |

### 5.8 欢迎屏组件

| 组件 | 文件路径 | 说明 |
|-----|---------|-----|
| `WelcomeScreen` | [`src/components/game/WelcomeScreen.tsx`](src/components/game/WelcomeScreen.tsx) | 欢迎/大厅屏幕，玩家签名输入、开始游戏按钮、设置入口、赞助卡片、登录/账户、开发者控制台 |

### 5.9 其他子组件/模态框

在 [`src/components/game/`](src/components/game/) 目录下还有其他组件：
- `AuthModal.tsx` — 登录/注册模态框
- `AccountModal.tsx` — 账户模态框
- `UserProfileModal.tsx` — 用户资料（积分、兑换码、推荐）
- `SharePanel.tsx` — 分享/推荐面板
- `LowCreditModal.tsx` — 积分不足提示
- `CustomCharacterModal.tsx` — 自定义角色管理
- `GameSetupModal.tsx` — 游戏设置模态框
- `LocaleSwitcher.tsx` — 语言切换器
- `ResetPasswordModal.tsx` — 密码重置

### 5.10 开发者工具

| 组件 | 文件路径 | 说明 |
|-----|---------|-----|
| `DevConsole` | [`src/components/DevTools.tsx`](src/components/DevTools.tsx) | 开发者控制台（非生产环境显示），角色预设、固定角色配置 |
| `DevModeButton` | [`src/components/DevTools.tsx`](src/components/DevTools.tsx) | 开发者模式入口按钮 |

---

## 六、场景切换逻辑详解

### 6.1 场景定义

本项目没有多页面路由，所有"场景"都在单页内通过条件渲染实现：

1. **Welcome Scene**（欢迎场景）：`!gameStarted || !showTable`
2. **Role Reveal Scene**（角色揭示）：`isRoleRevealOpen && canShowRole`
3. **Night Scene**（夜晚）：`isNight === true`（视觉背景 + 特定 phase）
4. **Day Scene**（白天）：`isNight === false`（视觉背景 + 特定 phase）
5. **Game End Scene**（游戏结束）：`gameState.phase === "GAME_END"`

### 6.2 场景切换触发点

| 切换 | 触发条件 | 代码位置 |
|-----|---------|---------|
| Welcome → Game | `startGame()` 成功 | [`src/hooks/useGameLogic.ts`](src/hooks/useGameLogic.ts) |
| Game → Role Reveal | `NIGHT_START` 阶段且人类玩家存活 | [`src/app/page.tsx`](src/app/page.tsx) |
| Role Reveal → Night | 点击"继续"按钮 | [`src/app/page.tsx`](src/app/page.tsx) `continueAfterRoleReveal()` |
| Day → Night | `startNightPhase()` | [`src/hooks/useGameLogic.ts`](src/hooks/useGameLogic.ts) |
| Night → Day | `resolveNight()` 完成 | [`src/hooks/game-phases/useSpecialEvents.ts`](src/hooks/game-phases/useSpecialEvents.ts) |
| Day → Vote | 发言轮次结束 | [`src/game/phases/DaySpeechPhase.ts`](src/game/phases/DaySpeechPhase.ts) `advanceSpeaker()` |
| Vote → Day Resolve | 投票完成 | [`src/game/phases/VotePhase.ts`](src/game/phases/VotePhase.ts) `resolveVotes()` |
| Any → Game End | `checkWinCondition()` 返回非 null | 多处调用 |

### 6.3 日夜视觉切换的完整流程

**代码位置**: [`src/app/page.tsx`](src/app/page.tsx) 第 243~300 行

```
isNight 变为 true
  → 设置 pendingNightBlinkRef.current = true
  → 等待 Ritual Cue "天黑请闭眼" 显示
  → scheduleDayNightBlink(true, delay)
    → "closing" 阶段（360ms）：眼睛闭上（CSS 遮罩）
    → 切换 visualIsNight = true
    → "hold" 阶段（120ms）
    → "opening" 阶段（620ms）：眼睛睁开
  → GameBackground 收到 isNight=true，渐变切换背景
  → BGM 从 day.mp3 淡入淡出切换到 night.mp3
```

### 6.4 Phase 驱动的 UI 条件渲染

**文件**: [`src/components/game/DialogArea.tsx`](src/components/game/DialogArea.tsx)

```typescript
const showWitchPanel = phase === "NIGHT_WITCH_ACTION" && humanPlayer?.role === "Witch" && !isWaitingForAI;
const showHumanInput = isHumanTurn && phase !== "GAME_END" && phase !== "DAY_BADGE_SIGNUP";
const showDialogueBlock = !isHumanTurn && (currentSpeaker || waitingForNextRound) && ...;
const showNightWaiting = !isHumanTurn && !currentSpeaker && isNightActionPhase && ...;
```

**文件**: [`src/components/game/BottomActionPanel.tsx`](src/components/game/BottomActionPanel.tsx)

```typescript
// 根据 phase 和 humanPlayer.role 显示不同按钮
if (phase === "DAY_VOTE") show "确认投票";
if (phase === "NIGHT_SEER_ACTION" && role === "Seer") show "确认查验";
if (phase === "NIGHT_WOLF_ACTION" && isWolfRole(role)) show "确认刀人";
if (phase === "NIGHT_GUARD_ACTION" && role === "Guard") show "确认守护";
if (phase === "HUNTER_SHOOT" && role === "Hunter") show "确认开枪" / "跳过";
if (phase === "WHITE_WOLF_KING_BOOM" && role === "WhiteWolfKing") show "确认自爆";
```

---

## 七、AI 与游戏流程控制

### 7.1 异步流程控制器

**文件**: [`src/lib/game-flow-controller.ts`](src/lib/game-flow-controller.ts)

```typescript
export class AsyncFlowController {
  private tokenValue = 0;
  getToken(): FlowToken {
    const capturedValue = this.tokenValue;
    return { value: capturedValue, isValid: () => this.tokenValue === capturedValue };
  }
  interrupt(): void { this.tokenValue += 1; }
}
```

**FlowToken 模式**：每个异步操作前获取 token，await 后检查 `token.isValid()`，如果流程被中断（如游戏重置）则 token 失效，后续操作被取消。

### 7.2 阶段管理器

**文件**: [`src/game/core/PhaseManager.ts`](src/game/core/PhaseManager.ts)

```typescript
constructor() {
  const nightPhase = new NightPhase();
  const votePhase = new VotePhase();
  const daySpeechPhase = new DaySpeechPhase();
  this.phases = {
    NIGHT_START: nightPhase,
    NIGHT_GUARD_ACTION: nightPhase,
    NIGHT_WOLF_ACTION: nightPhase,
    NIGHT_WITCH_ACTION: nightPhase,
    NIGHT_SEER_ACTION: nightPhase,
    DAY_VOTE: votePhase,
    DAY_SPEECH: daySpeechPhase,
    DAY_LAST_WORDS: daySpeechPhase,
    DAY_BADGE_SPEECH: daySpeechPhase,
    DAY_PK_SPEECH: daySpeechPhase,
    // ... 其他映射
  };
}
```

### 7.3 游戏阶段基类

**文件**: [`src/game/core/GamePhase.ts`](src/game/core/GamePhase.ts)

```typescript
export abstract class GamePhase {
  abstract onEnter(context: GameContext): Promise<void>;
  abstract getPrompt(context: GameContext, player: Player): PromptResult;
  abstract handleAction(context: GameContext, action: GameAction): Promise<void>;
  abstract onExit(context: GameContext): Promise<void>;
}
```

### 7.4 Prompt 生成

每个 `GamePhase` 子类实现 `getPrompt()` 方法，为特定角色生成 LLM 的系统提示词和用户提示词。

**文件列表**：
- [`src/game/phases/NightPhase.ts`](src/game/phases/NightPhase.ts) — 夜间阶段提示词
- [`src/game/phases/VotePhase.ts`](src/game/phases/VotePhase.ts) — 投票阶段提示词
- [`src/game/phases/DaySpeechPhase.ts`](src/game/phases/DaySpeechPhase.ts) — 白天发言提示词
- [`src/game/phases/BadgePhase.ts`](src/game/phases/BadgePhase.ts) — 警长竞选提示词
- [`src/game/phases/HunterPhase.ts`](src/game/phases/HunterPhase.ts) — 猎人开枪提示词
- [`src/game/phases/WhiteWolfKingBoomPhase.ts`](src/game/phases/WhiteWolfKingBoomPhase.ts) — 白狼王自爆提示词

---

## 八、持久化与恢复

### 8.1 LocalStorage Checkpoint

**文件**: [`src/store/game-machine.ts`](src/store/game-machine.ts)

每次 `setGameState()` 自动保存到 localStorage（24h TTL）：
```typescript
export const gameStateAtom = atom(
  (get) => get(rawGameStateAtom),
  (get, set, update) => {
    const next = typeof update === "function" ? update(prev) : update;
    set(rawGameStateAtom, next);
    saveGameState(next);  // localStorage.setItem("wolfcha-game-state", ...)
  }
);
```

### 8.2 页面刷新恢复

**文件**: [`src/hooks/useGameLogic.ts`](src/hooks/useGameLogic.ts)

```typescript
// 初始化时尝试恢复
const saved = loadGameState();
if (saved && isGameInProgress(saved)) {
  // 恢复到保存的 phase，继续流程
}
```

---

## 九、音频系统

### 9.1 音频管理器

**文件**: [`src/lib/audio-manager.ts`](src/lib/audio-manager.ts)

`AudioManager` 单例：基于任务队列的顺序音频播放，支持 TTS 语音预取。

### 9.2 旁白语音

**文件**: [`src/lib/narrator-audio-player.ts`](src/lib/narrator-audio-player.ts)

根据游戏事件播放预设旁白（如"天黑请闭眼"、"猎人请开枪"等）。

### 9.3 BGM 管理

**文件**: [`src/app/page.tsx`](src/app/page.tsx) 第 307~520 行

- 使用原生 HTMLAudioElement
- 支持跨曲目淡入淡出（fadeAudio）
- 循环播放时尾部淡入淡出（attachLoopFade）
- 日夜自动切换曲目

---

## 十、总结：事件流全景图

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户交互 / AI 决策                         │
│   (点击玩家 / 选择动作 / AI generateXXX 调用)                     │
└───────────────────────────┬─────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                     setGameState(newState)                        │
│              (事件发布 = 状态变更)                                  │
└───────────────────────────┬─────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              Jotai Atom 通知所有订阅者 (React 重渲染)                │
└───────────────────────────┬─────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  page.tsx (根组件)                                               │
│  ├── 检查 gameState.phase → 决定显示什么阶段 UI                    │
│  ├── 检查 isNight → 切换 GameBackground / BGM                   │
│  ├── 检查 gameState.nightActions → 触发 NightActionOverlay       │
│  ├── 检查 gameState.messages → 触发 RitualCue                    │
│  └── 传递状态给子组件 via props                                   │
└───────────────────────────┬─────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  子组件条件渲染                                                   │
│  ├── DialogArea: 根据 phase 显示对话/输入/女巫面板/投票进度         │
│  ├── PlayerCardCompact: 根据 alive/selected/isSpeaking 改变样式    │
│  ├── BottomActionPanel: 根据 phase + role 显示操作按钮             │
│  ├── VotingProgress: 根据 votes 实时更新                          │
│  ├── WolfPlanningPanel: 根据 wolfVotes 显示狼队协商状态             │
│  └── EventLog: 根据 nightHistory/dayHistory 显示历史事件           │
└─────────────────────────────────────────────────────────────────┘
```

---

*文档生成时间: 2026-05-19*
*基于 Wolfcha 项目代码分析*
