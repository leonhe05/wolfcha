# 狼人杀前端改造为多人联机模式 — 实施计划

## 上下文

当前 Wolfcha 是一个单机 AI 驱动的狼人杀游戏，所有游戏逻辑（阶段流转、AI 行动生成、胜利判定、状态更新）都在前端完成，通过 Jotai `gameStateAtom` 管理状态。现需改造为多人在线联机模式：后端控制所有状态流转，前端通过 Socket.IO 接收状态更新事件，仅负责 UI 渲染。

用户明确不擅长前端开发，因此本计划遵循**最小改动、最大复用**原则，保留所有 UI 组件不变，只替换"状态生产者"。

---

## 现状分析

### 前端目前承担的工作

| 职责 | 所在文件 | 联机后是否需要 |
|------|---------|--------------|
| 游戏状态管理 (Jotai) | `src/store/game-machine.ts` | ✅ 保留，只读 |
| 阶段流转调度 | `src/hooks/useGameLogic.ts` | ❌ 删除，后端接管 |
| AI 行动生成 | `src/lib/game-master.ts` | ❌ 删除，后端接管 |
| Phase 生命周期 | `src/game/phases/*.ts` | ❌ 删除，后端接管 |
| PhaseManager | `src/game/core/PhaseManager.ts` | ❌ 删除 |
| 人类玩家操作处理 | `src/hooks/useGameLogic.ts` | ✅ 改造为发送 Socket.IO 事件 |
| 对话/语音管理 | `src/hooks/useDialogueManager.ts` | ✅ 保留（AI 发言） |
| UI 渲染 | `src/app/page.tsx`, `src/components/game/*.tsx` | ✅ 完全保留 |

### 核心改造点

前端目前的工作模式：

```
人类操作 → handleXXX() → 直接 setGameState() → 自动触发阶段推进 → AI 行动 → setGameState()
```

目标工作模式：

```
人类操作 → handleXXX() → socket.emit(action) → 后端计算 → socket.on(event) → setGameState(newState)
```

---

## 推荐方案：薄前端 + 全量状态同步

### 方案概述

后端通过 Socket.IO 广播完整的 `GameState` JSON，前端收到后直接 `setGameState(receivedState)` 替换整个状态。这是实现最简单、前后端耦合最低的方式。

**为什么不使用增量事件？**
- 增量事件需要前端维护事件合并逻辑，容易出 bug
- 全量状态同步前端代码几乎不用改，只需要把原来的"本地计算新状态"换成"直接赋值后端给的状态"
- 狼人杀状态对象不大（几十KB），完全在 Socket.IO 承受范围内

---

## 具体实施步骤

### 步骤 1：保留所有 UI 类型和状态定义（无需改动）

**保留文件清单**：
- `src/types/game.ts` — `GameState`, `Player`, `Phase`, `Role` 等类型
- `src/store/game-machine.ts` — `gameStateAtom`, `uiStateAtom` 定义
- `src/components/game/*.tsx` — 所有 UI 组件（DialogArea, PlayerCardCompact, VotingProgress 等）
- `src/app/page.tsx` — 主页面渲染逻辑（只读状态的部分）

**理由**：这些文件只读取 `gameState`，不关心状态从何而来。

### 步骤 2：新建 Socket.IO 游戏 Hook（核心改动）

**新建文件**：`src/hooks/useOnlineGame.ts`

功能职责：
1. 连接 Socket.IO（后端地址从 env 配置读取）
2. 接收后端推送的完整 `GameState`，调用 `setGameState()` 更新
3. 将人类玩家操作通过 Socket.IO 事件发送给后端
4. 暴露与 `useGameLogic` 兼容的 API 给 `page.tsx`

伪代码结构：

```typescript
import { io, Socket } from 'socket.io-client';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001';

export function useOnlineGame() {
  const [gameState, setGameState] = useAtom(gameStateAtom);
  const socketRef = useRef<Socket | null>(null);

  // 连接 Socket.IO
  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ['websocket'] });

    socket.on('STATE_UPDATE', (newState: GameState) => {
      setGameState(newState); // ← 直接替换整个状态
    });

    socket.on('SPEECH_START', (payload) => {
      // 交给 useDialogueManager 处理
    });

    socket.on('ERROR', (payload) => {
      toast.error(payload.message);
    });

    socketRef.current = socket;
    return () => { socket.disconnect(); };
  }, []);

  const sendAction = useCallback(<T>(event: string, payload: T) => {
    socketRef.current?.emit(event, payload);
  }, []);

  // 人类操作：只发送，不计算状态
  const handleHumanVote = useCallback((targetSeat: number) => {
    sendAction('VOTE', { targetSeat });
  }, [sendAction]);

  const handleNightAction = useCallback((targetSeat: number, witchAction?: string) => {
    sendAction('NIGHT_ACTION', { targetSeat, witchAction });
  }, [sendAction]);

  const handleHumanSpeech = useCallback((content: string) => {
    sendAction('SPEECH', { content });
  }, [sendAction]);

  const handleBadgeSignup = useCallback((wants: boolean) => {
    sendAction('BADGE_SIGNUP', { wants });
  }, [sendAction]);

  // ... 其他操作同理

  return {
    gameState,
    handleHumanVote,
    handleNightAction,
    handleHumanSpeech,
    // ... 与 page.tsx 兼容的 API
  };
}
```

### 步骤 3：改造主页面入口

**修改文件**：`src/app/page.tsx`

把原来的：
```typescript
const { gameState, handleHumanVote, ... } = useGameLogic();
```

换成：
```typescript
const { gameState, handleHumanVote, ... } = useOnlineGame();
```

**UI 渲染逻辑完全不用改**，因为 `useOnlineGame` 返回的 API 签名与 `useGameLogic` 兼容。

### 步骤 4：移除前端本地游戏逻辑（清理工作）

**可删除/归档的文件清单**：

| 文件/目录 | 说明 |
|----------|------|
| `src/hooks/useGameLogic.ts` | 约 2300 行的本地游戏主控，可被 `useOnlineGame.ts` 完全替代 |
| `src/game/phases/NightPhase.ts` | 夜间阶段逻辑 |
| `src/game/phases/DaySpeechPhase.ts` | 白天发言阶段逻辑 |
| `src/game/phases/VotePhase.ts` | 投票阶段逻辑 |
| `src/game/phases/BadgePhase.ts` | 警长竞选阶段逻辑 |
| `src/game/phases/HunterPhase.ts` | 猎人开枪阶段逻辑 |
| `src/game/phases/WhiteWolfKingBoomPhase.ts` | 白狼王自爆阶段逻辑 |
| `src/game/core/PhaseManager.ts` | 阶段管理器 |
| `src/game/core/GamePhase.ts` | 阶段基类 |
| `src/hooks/game-phases/useBadgePhase.ts` | 警长竞选子 hook |
| `src/hooks/game-phases/useSpecialEvents.ts` | 特殊事件子 hook |
| `src/hooks/game-phases/useDayPhase.ts` | 白天阶段子 hook |
| `src/lib/game-master.ts` | AI 行动生成函数（`generateWolfAction`, `generateAIVote` 等）|
| `src/lib/game-flow-controller.ts` | `AsyncFlowController`（前端流程控制不再需要）|

**可复用到后端的文件**（如果后端也是 TypeScript/Node.js）：
- `src/types/game.ts` — 类型定义可前后端共享
- `src/lib/game-master.ts` — `killPlayer`, `transitionPhase`, `checkWinCondition` 等纯函数可搬到后端
- `src/game/phases/*.ts` — Prompt 生成逻辑可搬到后端驱动 AI

### 步骤 5：处理 AI 语音/流式发言

当前 AI 发言流程：
1. 前端调用 `/api/chat` 获取 SSE 流
2. 前端逐字显示（typewriter 效果）
3. 前端调用 `/api/tts` 获取语音

联机后方案：
- **推荐**：后端生成 AI 发言文本，通过 Socket.IO 发送给前端
- 流式效果：后端可分段发送（`SPEECH_START`, `SPEECH_CHUNK`, `SPEECH_END`）
- TTS：前端收到完整文本后自己调 `/api/tts`，或后端预生成语音 URL

前端需要保留 `useDialogueManager.ts`，但输入源从"本地生成"变成"Socket.IO 接收"。

### 步骤 6：处理本地持久化（localStorage）

当前游戏状态自动保存到 localStorage 用于页面刷新恢复。

联机后方案：
- **简单方案**：关闭前端 localStorage 持久化。页面刷新后重新连接 Socket.IO，后端发送当前完整状态
- 在 `src/store/game-machine.ts` 中注释掉 `saveGameState()` 调用

---

## 隐患分析：`isHuman` 与 `isMe` 的语义混淆

### 问题描述

当前单机模式的代码中，`isHuman` 字段同时承担了**两个语义**：

1. **这是真人玩家**（与 AI 相对）—— 多人模式下仍然成立
2. **这是我自己**（当前客户端控制的用户）—— **多人模式下不成立**

在单人模式中，整个游戏只有一个 `isHuman=true` 的玩家，因此代码里大量用 `player.isHuman` 来隐含表达 `"player === 我自己"`。联机后房间里有多个真人，这个假设会直接导致以下 Bug：

- 所有真人玩家的卡片都高亮为"我"
- 所有真人玩家的消息都在左侧高亮显示
- 发言输入框在任意真人发言时都显示给当前用户
- 夜间操作判定错乱（把其他真人当成自己来跳过 AI 流程）
- 投票阶段不能选择任何真人（包括其他玩家），而不是不能选择自己

### 影响范围清单

#### A. "isMe" 判断（把 `isHuman` 当成自己）

| 文件 | 行号 | 当前代码 | 问题 |
|------|------|---------|------|
| `src/components/game/PlayerCardCompact.tsx` | 57 | `const isMe = player.isHuman;` | 所有真人卡片都高亮为"我" |
| `src/components/game/PlayerDetailModal.tsx` | 62 | `const isMe = !!renderPlayer?.isHuman;` | 所有真人详情弹窗显示"我" |
| `src/components/game/VotingProgress.tsx` | 166-171 | `p.isHuman ? t("youSuffix")` | 所有真人都带"你"后缀 |
| `src/components/game/WolfPlanningPanel.tsx` | 79 | `wolf.isHuman ? "你" : ...` | 真人狼队友显示"你" |
| `src/components/game/DialogArea.tsx` | 1774 | `msg.playerId === humanPlayerId` | `humanPlayerId` 本身来自 `find(p => p.isHuman)`，只返回第一个真人 |

#### B. "轮到我"判断（轮到谁发言/操作）

| 文件 | 行号 | 当前代码 | 问题 |
|------|------|---------|------|
| `src/app/page.tsx` | 1582 | `currentSpeakerSeat === humanPlayer?.seat` | `humanPlayer` 是首个真人，不是当前用户 |
| `src/components/game/DialogArea.tsx` | 261, 475-509, 997-1004 | `isHumanTurn` prop | 任意真人发言时都显示输入框给当前用户 |
| `src/hooks/useGameLogic.ts` | 981, 1026 | `currentSpeaker.isHuman` / `lastWordsSpeaker.isHuman` | 真人遗言时当前用户都能输入 |

#### C. 夜间行动权限与目标选择

| 文件 | 行号 | 当前代码 | 问题 |
|------|------|---------|------|
| `src/store/game-machine.ts` | 556 | `humanPlayerAtom = find(p => p.isHuman)` | 只返回第一个真人 |
| `src/store/game-machine.ts` | 670, 739, 809, 846, 862 | `target.isHuman` | 禁止选择**任何**真人，应为禁止选择**自己** |
| `src/hooks/useGameLogic.ts` | 863, 903, 937 | `!guard.isHuman` / `!witch?.isHuman` | 判断"是否需要 AI 代操作"时，把其他真人也算进去了 |
| `src/game/phases/NightPhase.ts` | 138, 187, 265, 320 | `guard.isHuman` / `witch.isHuman` | 多真人时只处理第一个真人的行动 |

#### D. 可以**保留**的 `isHuman` 用法（语义是"是否为真人"，与"是不是我"无关）

| 文件 | 行号 | 用法 | 说明 |
|------|------|------|------|
| `src/app/page.tsx` | 78 | `!player.isHuman` | 判断是否显示 AI 模型 logo（真人用头像，AI 用模型图） |
| `src/components/game/DialogArea.tsx` | 104 | `player.isHuman ? displayName : persona` | 判断信息展示方式 |
| `src/store/game-machine.ts` | 574 | `!p.isHuman` | `aiPlayersAtom` 筛选 AI 玩家 |
| `src/components/DevTools/DevConsole.tsx` | 1526, 1626 | `player.isHuman` | DevTools 标识真人玩家 |

### 解决方案：引入 `myPlayerId`

#### 核心思路

用 **`myPlayerId`** 明确标识当前客户端对应的玩家，把 `"isMe"` 和 `"isHuman"` 解耦。

- `isHuman` = 该玩家是真人（不是 AI）
- `playerId === myPlayerId` = 该玩家是"我自己"

#### 具体改动步骤

**Step 1：前端存储 `myPlayerId`**

在 `src/store/game-machine.ts` 中新增一个 atom：

```typescript
export const myPlayerIdAtom = atom<string | null>(null);
```

`myPlayerId` 由后端在 `JOIN_ROOM` 的 ack 回调中下发，前端收到后立即写入 atom。角色揭示由 `STATE_UPDATE(phase: "NIGHT_START")` 自动触发，复用现有 `page.tsx` 逻辑。

**Step 2：新增/修改派生 atoms**

```typescript
// 当前客户端对应的玩家（我自己）
export const myPlayerAtom = atom((get) => {
  const gameState = get(gameStateAtom);
  const myPlayerId = get(myPlayerIdAtom);
  return gameState.players.find((p) => p.playerId === myPlayerId) || null;
});

// 当前客户端的座位号
export const mySeatAtom = atom((get) => {
  const myPlayer = get(myPlayerAtom);
  return myPlayer?.seat ?? null;
});

// ⚠️ humanPlayerAtom 保留但语义变为"第一个真人"，仅兼容旧代码过渡使用
// 所有 UI 中需要"我自己"的场景都应改用 myPlayerAtom
```

**Step 3：替换所有 "isMe" 判断**

全局替换 `player.isHuman` → `player.playerId === myPlayerId`（仅限表达"是我自己"的场景）：

```typescript
// PlayerCardCompact.tsx
const isMe = player.playerId === myPlayerId;

// PlayerDetailModal.tsx
const isMe = renderPlayer?.playerId === myPlayerId;

// VotingProgress.tsx
{p.playerId === myPlayerId ? t("votingProgress.youSuffix") : ""}

// WolfPlanningPanel.tsx
{wolf.playerId === myPlayerId ? "你" : wolf.displayName}

// DialogArea.tsx
const isHuman = msg.playerId === myPlayerId;
```

**Step 4：替换所有 "轮到我" 判断**

```typescript
// page.tsx 中 isHumanTurn 的计算
const isMyTurn = (gameState.phase === "DAY_SPEECH" || ...)
  && gameState.currentSpeakerSeat === myPlayer?.seat
  && !waitingForNextRound;

// DialogArea.tsx 的 isHumanTurn prop
// 改为 isMyTurn，语义更明确
```

**Step 5：替换所有"不能选自己"的目标校验**

```typescript
// game-machine.ts 中的 PHASE_CONFIGS
// 原：
if (target.isHuman) return false;
// 改为：
if (target.playerId === myPlayerId) return false;
```

**Step 6：后端配合（`myPlayerId` 的下发）**

前端加入房间时，通过 Socket.IO 的 ack 机制立即获得自己的 `playerId`：

```typescript
// 前端
socket.emit('JOIN_ROOM', { roomId: 'abc123', playerName: '张三' }, (response) => {
  setMyPlayerId(response.yourPlayerId);  // 一加入就知道自己是谁
});
```

```python
# 后端
@sio.on('JOIN_ROOM')
async def join_room(sid, data):
    room_id = data['roomId']
    player_name = data['playerName']
    player_id = f'p_{sid[:6]}'
    # ... 加入房间逻辑
    await sio.emit('ROOM_INFO', {...}, room=room_id)
    return {'yourPlayerId': player_id}  # ack 回调
```

断线重连后，Socket.IO 会自动重连，前端重新 emit `JOIN_ROOM`，后端返回相同的 `playerId`（只要房间还在）。

**Step 7：角色揭示**

无需新加 Socket.IO 事件。后端分配完角色后，直接推送 `STATE_UPDATE(phase: "NIGHT_START", day: 1)`。前端现有逻辑（`page.tsx:868-879`）会自动检测到 `phase === "NIGHT_START" && day >= 1`，打开 `RoleRevealOverlay` 弹窗。

玩家点击"继续"后，前端 emit `CONTINUE`（或等待后端超时自动推进），后端进入下一个阶段并广播 `STATE_UPDATE`。

### 改动优先级

| 优先级 | 改动项 | 不做的后果 |
|--------|--------|-----------|
| **P0** | 新增 `myPlayerIdAtom` / `myPlayerAtom` | 无法确定"我是谁" |
| **P0** | `PlayerCardCompact` / `PlayerDetailModal` 的 `isMe` 判断 | 所有真人卡片都高亮为"我" |
| **P0** | `DialogArea` 的 `isHumanTurn` → `isMyTurn` | 任意真人发言时当前用户都看到输入框 |
| **P0** | `game-machine.ts` 的 `canSelectPlayer` 中 `target.isHuman` → `target.playerId === myPlayerId` | 无法投票/操作其他真人玩家 |
| **P1** | `page.tsx` 中 `humanPlayer?.seat` → `myPlayer?.seat` | 夜间行动判定错乱 |
| **P1** | `useGameLogic.ts` 中 `humanPlayer` 引用清理 | 旧 hook 被删除时自然消除 |
| **P2** | `humanPlayerAtom` 标记为 deprecated | 提醒后续开发不要再用 |

---

## Socket.IO 通信协议设计

### 协议约定

- 使用 **Socket.IO**（`python-socketio` + `socket.io-client`）代替原生 WebSocket
- **Event Name 即 Action**：用 `socket.emit('EVENT_NAME', payload)` 代替原生 WS 的 JSON `type`/`payload` 结构
- 心跳、重连、房间管理由 Socket.IO 内置处理，无需手动实现
- 业务数据直接作为 payload 传递，无需再包一层 `payload` 字段

### 客户端 → 服务端（C2S）

```typescript
// 加入房间（输入名字后发送）
socket.emit('JOIN_ROOM', { roomId: 'abc123', playerName: '张三' });

// 准备/取消准备
socket.emit('READY', { ready: true });

// 开始游戏（仅房主可发送）
socket.emit('START_GAME');

// 投票
socket.emit('VOTE', { targetSeat: 3 });

// 夜间行动
// guard / wolf / seer: 只需 targetSeat
// witch: 需额外传 witchAction
socket.emit('NIGHT_ACTION', { targetSeat: 3, witchAction: 'save' });
// witchAction 可选: "save" | "poison" | "pass"

// 白天发言
socket.emit('SPEECH', { content: '我觉得3号有问题...' });

// 警长竞选报名
socket.emit('BADGE_SIGNUP', { wants: true });

// 警长移交
socket.emit('BADGE_TRANSFER', { targetSeat: 2 });
// targetSeat: -1 表示撕毁警徽

// 猎人开枪
socket.emit('HUNTER_SHOOT', { targetSeat: 3 });
// targetSeat: null 表示不开枪

// 白狼王自爆
socket.emit('WWK_BOOM', { targetSeat: 3 });
// targetSeat: null 表示不带人
```

### 服务端 → 客户端（S2C）

#### 1. STATE_UPDATE — 状态更新（最核心消息）

后端在每个阶段流转、玩家操作、AI 行动后发送。payload 为**该玩家可见的脱敏 GameState**。

```typescript
socket.emit('STATE_UPDATE', {
  roomId: 'abc123',
  phase: 'DAY_SPEECH',
  day: 1,
  players: [...],
  messages: [...],
  votes: {...},
  nightActions: {...},
  badge: {...},
  ...
});
```

**前端处理**：
```typescript
socket.on('STATE_UPDATE', (newState: GameState) => {
  setGameState(newState);
});
```

#### 2. SPEECH_START — 发言开始（驱动当前对话显示）

用于驱动 `DialogArea` 的当前发言者显示和打字机效果。后端在玩家或 AI 开始发言时发送。

```typescript
socket.emit('SPEECH_START', {
  playerId: 'p_123',
  playerName: '李四',
  content: '完整的发言内容',
  phase: 'DAY_SPEECH',
  day: 1,
  isStreaming: false
});
```

**前端处理**：
```typescript
socket.on('SPEECH_START', (payload) => {
  setDialogue(payload.playerName, payload.content, payload.isStreaming);
});
```

#### 3. SPEECH_CHUNK — 流式发言片段（AI 流式输出时使用）

如果后端使用 SSE/流式生成 AI 回复，可以分段推送，前端追加显示。

```typescript
socket.emit('SPEECH_CHUNK', {
  playerId: 'p_123',
  chunk: '我觉得',
  isFinal: false
});
```

**前端处理**：追加到当前对话文本，或交给 `useDialogueManager` 处理。

> 如果后端是等 AI 生成完整文本后再发送，可以省略 SPEECH_CHUNK，直接用 SPEECH_START 一次性发送完整内容。

#### 4. SPEECH_END — 发言结束

```typescript
socket.emit('SPEECH_END', {
  playerId: 'p_123',
  fullContent: '完整的发言内容'
});
```

**前端处理**：标记当前段完成，允许玩家按回车/点击继续下一位。

#### 5. ACTION_RESULT — 夜间行动结果（仅发给行动者）

用于发送私有行动结果，如预言家查验结果。这类信息不通过 STATE_UPDATE 广播（因为 STATE_UPDATE 中的 `nightActions` 已经做了脱敏，但查验结果需要更明确的提示）。

```typescript
socket.emit('ACTION_RESULT', {
  actionType: 'seer',
  result: { targetSeat: 3, isWolf: false }
});
```

**前端处理**：显示在对话框中（如"3号玩家是好人"）。

#### 6. SYSTEM_MESSAGE — 系统提示（不需要改状态的轻量消息）

用于播放旁白语音、显示仪式提示等。如果该消息需要进入历史记录，应通过 STATE_UPDATE 的 `messages` 数组发送。

```typescript
socket.emit('SYSTEM_MESSAGE', {
  content: '天亮了',
  category: 'dayBreak',
  playNarrator: 'dayBreak'
});
```

#### 7. ROOM_INFO — 房间信息（等待阶段使用）

游戏开始前，用于显示房间内的玩家列表和准备状态。

```typescript
socket.emit('ROOM_INFO', {
  roomId: 'abc123',
  status: 'waiting',
  players: [
    { playerId: 'p_1', name: '张三', isHost: true, isReady: true },
    { playerId: 'p_2', name: '李四', isHost: false, isReady: false }
  ]
});
```

#### 8. PLAYER_JOINED / PLAYER_LEFT — 玩家进出

```typescript
socket.emit('PLAYER_JOINED', { player: { playerId: 'p_2', name: '李四' } });
socket.emit('PLAYER_LEFT', { playerId: 'p_2' });
```

#### 9. GAME_END — 游戏结束

```typescript
socket.emit('GAME_END', {
  winner: 'village',
  roleReveal: [
    { playerId: 'p_1', seat: 0, name: '张三', role: 'Seer' },
    { playerId: 'p_2', seat: 1, name: '李四', role: 'Werewolf' }
  ]
});
```

#### 10. ERROR — 错误提示

```typescript
socket.emit('ERROR', {
  code: 'INVALID_TARGET',
  message: '不能选择已死亡的玩家'
});
```

**前端处理**：`toast.error(message)`

---

## 前端消息处理总览

```typescript
// useOnlineGame.ts 中的 socket 事件监听示例
useEffect(() => {
  const socket = io(SOCKET_URL);

  socket.on('STATE_UPDATE', (newState: GameState) => {
    setGameState(newState);
    setIsWaitingForAI(false); // 收到新状态说明后端处理完了
  });

  socket.on('SPEECH_START', (payload) => {
    setDialogue(payload.playerName, payload.content, payload.isStreaming);
  });

  socket.on('SPEECH_CHUNK', (payload) => {
    // 追加文本到当前对话（如果支持流式）
    appendDialogue(payload.chunk);
  });

  socket.on('SPEECH_END', () => {
    markCurrentSegmentCompleted();
  });

  socket.on('ACTION_RESULT', (payload) => {
    // 显示私有行动结果（如预言家查验）
    setDialogue('系统', formatActionResult(payload), false);
  });

  socket.on('SYSTEM_MESSAGE', (payload) => {
    // 播放旁白、显示仪式提示
    if (payload.playNarrator) {
      playNarrator(payload.playNarrator);
    }
  });

  socket.on('GAME_END', (payload) => {
    // 游戏结束，显示结果
  });

  socket.on('ROOM_INFO', (payload) => {
    // 更新房间玩家列表 UI
  });

  socket.on('ERROR', (payload) => {
    toast.error(payload.message);
    setIsWaitingForAI(false);
  });

  socketRef.current = socket;
  return () => { socket.disconnect(); };
}, []);
```

---

## 状态同步与信息可见性架构（重要）

狼人杀的核心是**信息不对称**。预言家的查验、狼人的夜间讨论、女巫的用药、守卫的保护目标都是私有信息，不能暴露给不应看到的玩家。

### 方案对比

| 方案 | 实现方式 | 前端复杂度 | 安全性 | 推荐 |
|------|---------|-----------|--------|------|
| A：广播公开 + 私发私有 | 广播1条公开信息，再逐个私发n条私有信息 | 高（需合并两份状态） | 安全 | ❌ |
| B：每人合成视图 | 后端为每个玩家生成一份**脱敏后的完整状态**，逐个发送 | 极低（直接 setGameState） | 安全 | ✅ |

**为什么选方案B：**
- 前端只处理一种消息，收到后直接 `setGameState(payload)`，无需任何合并逻辑
- 不会出现"广播先到、私发后到"的中间不一致状态
- 玩家断线重连时，后端只需重新发一份当前视图即可恢复，无需补发多条消息
- 天然支持复杂的信息暴露规则（如游戏结束后才公布所有人身份）

### 哪些字段需要按角色脱敏

| 字段 | 可见角色 | 其他人看到 |
|------|---------|-----------|
| `players[i].role` | 仅自己 | `undefined` |
| `players[i].alignment` | 仅自己 | `undefined` |
| `nightActions.wolfVotes` / `wolfTarget` | 所有狼人 | `undefined` |
| `nightActions.seerResult` / `seerHistory` | 预言家 | `undefined` |
| `nightActions.witchSave` / `witchPoison` | 女巫 | `undefined` |
| `nightActions.guardTarget` | 守卫 | `undefined` |
| `nightActions.wolfTarget` | 女巫（按规则知道刀口） | `undefined` |
| `messages` | 按 `visibility` 字段过滤 | 只收到 public 和 visibleTo 包含自己的 |

### Python 后端实现示例

```python
# game_sanitizer.py
from copy import deepcopy
from typing import Any

def is_wolf_role(role: str) -> bool:
    return role in ("Werewolf", "WhiteWolfKing")

def sanitize_game_state(full_state: dict, viewer_player_id: str) -> dict:
    """
    根据玩家身份，生成该玩家可见的 GameState 视图。
    这是后端状态同步的核心函数。
    """
    state = deepcopy(full_state)
    players = state.get("players", [])
    viewer = next((p for p in players if p["playerId"] == viewer_player_id), None)
    viewer_role = viewer["role"] if viewer else None

    # 1. 玩家角色脱敏：只暴露自己的 role/alignment
    for p in state["players"]:
        if p["playerId"] != viewer_player_id:
            p["role"] = None
            p["alignment"] = None
            # agentProfile 包含 persona，也隐藏（可选）
            p.pop("agentProfile", None)

    # 2. 夜间行动脱敏
    na = state.get("nightActions", {})
    sanitized_na = {}

    # 守卫：只看到自己的守护目标
    if viewer_role == "Guard":
        sanitized_na["guardTarget"] = na.get("guardTarget")
        sanitized_na["lastGuardTarget"] = na.get("lastGuardTarget")

    # 狼人：看到狼队投票和目标
    if is_wolf_role(viewer_role):
        sanitized_na["wolfVotes"] = na.get("wolfVotes")
        sanitized_na["wolfTarget"] = na.get("wolfTarget")

    # 女巫：看到自己的用药，以及刀口（女巫有权知道 wolfTarget）
    if viewer_role == "Witch":
        sanitized_na["witchSave"] = na.get("witchSave")
        sanitized_na["witchPoison"] = na.get("witchPoison")
        sanitized_na["wolfTarget"] = na.get("wolfTarget")

    # 预言家：看到自己的查验结果和历史
    if viewer_role == "Seer":
        sanitized_na["seerTarget"] = na.get("seerTarget")
        sanitized_na["seerResult"] = na.get("seerResult")
        sanitized_na["seerHistory"] = na.get("seerHistory")

    state["nightActions"] = sanitized_na

    # 3. 消息脱敏：只保留 public 和 visibleTo 包含自己的消息
    messages = state.get("messages", [])
    state["messages"] = [
        msg for msg in messages
        if msg.get("visibility") == "public"
        or viewer_player_id in (msg.get("visibleTo") or [])
    ]

    # 4. 投票历史：按规则决定是否暴露具体票型
    # 默认公开；如需隐藏可在这里过滤

    return state
```

### 广播发送逻辑（Python + Socket.IO）

```python
# room_manager.py
import socketio
from copy import deepcopy
from typing import Dict
from game_sanitizer import sanitize_game_state

sio = socketio.AsyncServer(cors_allowed_origins='*')

# 内存中的房间数据
rooms: Dict[str, dict] = {}  # room_id -> room_data

async def get_room_by_sid(sid: str) -> str:
    """根据 socket sid 查找所在房间"""
    for room_id, room in rooms.items():
        if sid in room['sids']:
            return room_id
    return ''

@sio.on('JOIN_ROOM')
async def join_room(sid, data):
    room_id = data['roomId']
    player_name = data['playerName']

    if room_id not in rooms:
        rooms[room_id] = {
            'sids': {},           # sid -> player_info
            'state': {},          # 权威完整 GameState
            'started': False
        }

    room = rooms[room_id]
    room['sids'][sid] = {
        'playerId': f'p_{sid[:6]}',
        'name': player_name,
        'isHost': len(room['sids']) == 0,
        'isReady': False
    }

    sio.enter_room(sid, room_id)

    # 广播房间信息给该房间所有人
    await sio.emit('ROOM_INFO', {
        'roomId': room_id,
        'status': 'waiting',
        'players': list(room['sids'].values())
    }, room=room_id)

@sio.on('READY')
async def ready(sid, data):
    room_id = await get_room_by_sid(sid)
    room = rooms[room_id]
    room['sids'][sid]['isReady'] = data.get('ready', False)
    await sio.emit('ROOM_INFO', {
        'roomId': room_id,
        'status': 'waiting',
        'players': list(room['sids'].values())
    }, room=room_id)

@sio.on('START_GAME')
async def start_game(sid):
    room_id = await get_room_by_sid(sid)
    room = rooms[room_id]
    # 初始化权威状态...
    room['started'] = True
    await broadcast_state_update(room_id)

@sio.on('VOTE')
async def handle_vote(sid, data):
    room_id = await get_room_by_sid(sid)
    room = rooms[room_id]
    player_id = room['sids'][sid]['playerId']

    room['state']['votes'][player_id] = data['targetSeat']
    await broadcast_state_update(room_id)

@sio.on('NIGHT_ACTION')
async def handle_night_action(sid, data):
    room_id = await get_room_by_sid(sid)
    room = rooms[room_id]
    player_id = room['sids'][sid]['playerId']
    state = room['state']
    phase = state['phase']

    if phase == 'NIGHT_GUARD_ACTION':
        state['nightActions']['guardTarget'] = data['targetSeat']
    elif phase == 'NIGHT_WOLF_ACTION':
        # 记录狼人投票...
        pass
    elif phase == 'NIGHT_WITCH_ACTION':
        if data.get('witchAction') == 'save':
            state['nightActions']['witchSave'] = True
        elif data.get('witchAction') == 'poison':
            state['nightActions']['witchPoison'] = data['targetSeat']
    elif phase == 'NIGHT_SEER_ACTION':
        state['nightActions']['seerTarget'] = data['targetSeat']
        # 计算查验结果...

    await broadcast_state_update(room_id)

@sio.on('SPEECH')
async def handle_speech(sid, data):
    room_id = await get_room_by_sid(sid)
    room = rooms[room_id]
    player_id = room['sids'][sid]['playerId']

    room['state']['messages'].append({
        'id': generate_uuid(),
        'playerId': player_id,
        'content': data['content'],
        'timestamp': now(),
        'visibility': 'public',
    })

    await broadcast_state_update(room_id)

async def broadcast_state_update(room_id: str):
    """
    状态变更后，给房间内每个玩家发送各自的脱敏视图。
    这是每次阶段流转/操作后的标准调用。
    """
    room = rooms[room_id]
    full_state = room['state']

    for sid, player_info in room['sids'].items():
        player_id = player_info['playerId']
        view_state = sanitize_game_state(full_state, player_id)
        await sio.emit('STATE_UPDATE', view_state, to=sid)

async def send_to_player(sid: str, event: str, data: dict):
    """发送单条消息给指定玩家（如错误提示）"""
    await sio.emit(event, data, to=sid)
```

### 前端需要配合的改动

由于后端已经做了脱敏，**前端完全不需要改任何过滤逻辑**，只需保持：

```typescript
// useOnlineGame.ts
socket.on('STATE_UPDATE', (newState: GameState) => {
  setGameState(newState); // ← 直接替换，信任后端给的就是对的
});
```

---

## 后端需要广播的事件清单

后端通过 Socket.IO 广播（前端只需监听）：

| 事件 |  payload | 前端行为 |
|------|---------|---------|
| `STATE_UPDATE` | 完整 `GameState` JSON | `setGameState(payload)` |
| `SPEECH_START` | `{playerId, content}` | 开始显示打字机动画 |
| `SPEECH_CHUNK` | `{playerId, chunk}` | 追加显示文字 |
| `SPEECH_END` | `{playerId}` | 结束打字机，可继续下一位 |
| `ERROR` | `{message}` | toast 显示错误 |

---

## 后端应该复用前端的哪些代码

### 后端直接复用（推荐）

| 文件 | 复用内容 | 为什么能复用 |
|------|---------|------------|
| `src/types/game.ts` | `GameState`、`Player`、`Phase`、`Role`、`ChatMessage` 等所有类型定义，以及 `isWolfRole()` 辅助函数 | 纯类型定义，前后端共享可保证数据结构一致 |
| `src/lib/game-master.ts` | `killPlayer()`、`transitionPhase()`、`checkWinCondition()`、`tallyVotes()`、`addSystemMessage()`、`addPlayerMessage()` 等纯函数 | 这些函数只接收 state 并返回新 state，不涉及浏览器 API |
| `src/lib/prompt-utils.ts` | `buildGameContext()`、`buildTodayTranscript()`、`buildPlayerTodaySpeech()`、`getRoleText()`、`getWinCondition()` 等 | Prompt 构建工具，后端驱动 AI 时需要生成同样的提示词 |
| `src/lib/game-texts.ts` | `getSystemMessages()`、`getUiText()` | 系统消息文本模板，后端发送消息时需要相同的文案 |
| `src/lib/game-constants.ts` | `DELAY_CONFIG`、`GAME_CONFIG`、角色名称映射等常量 | 纯常量定义 |

### 后端可选复用（取决于实现方式）

| 文件 | 复用内容 | 说明 |
|------|---------|------|
| `src/game/phases/*.ts` | `getPrompt()` 方法 | 如果后端继续用同样的 LLM Prompt 策略驱动 AI，可以直接搬 `getPrompt()` 和 `buildBadgeElectionPrompt()` 等方法 |
| `src/lib/character-generator.ts` | AI 角色生成逻辑 | 如果后端负责创建 AI 玩家 persona，可以复用 |
| `src/lib/llm.ts` | LLM 调用封装 | 如果后端也用同样的 ZenMux/Dashscope 接口，请求封装逻辑可以复用 |

---

## 实施优先级

建议按以下顺序实施，每步都可独立验证：

1. **P0 — 核心骨架**：新建 `useOnlineGame.ts`，实现 Socket.IO 连接 + 全量状态接收 + `setGameState`
2. **P0 — 操作发送**：实现 `handleNightAction` 发送守卫/狼人/女巫/预言家操作
3. **P0 — 投票发送**：实现 `handleHumanVote` 发送投票
4. **P0 — 页面替换**：`page.tsx` 中把 `useGameLogic` 换成 `useOnlineGame`
5. **P1 — 发言发送**：实现 `handleHumanSpeech` 发送玩家发言
6. **P1 — 警长相关**：Badge signup / transfer 操作发送
7. **P1 — 移除旧代码**：删除 `useGameLogic.ts` 和所有 `src/game/` 阶段逻辑文件
8. **P2 — 语音/流式**：接入后端的 AI 发言流

---

## 验证方式

1. 启动后端 Socket.IO 服务器（返回 mock GameState）
2. 前端连接后应能正确渲染玩家桌面板
3. 点击玩家发送操作后，后端更新状态并广播，前端 UI 自动刷新
4. 无需测试阶段流转逻辑（后端负责）

---

## 关键设计决策说明

**Q: 为什么不保留部分前端逻辑（如胜利判定）做本地校验？**
A: 不需要。前端只做"展示层"，所有权威状态来自后端。前端可以本地缓存状态但不应基于它做决策。

**Q: `gameStateAtom` 的 Jotai 订阅还需要吗？**
A: 需要。所有 UI 组件都通过它读取状态。我们只是把"谁调用 setGameState"从本地逻辑改成了 Socket.IO 回调。

**Q: 后端可以复用前端的哪些代码？**
A: 如果后端也是 Node.js/TS：
- `src/types/game.ts` 完整复用
- `src/lib/game-master.ts` 中的纯函数（`killPlayer`, `transitionPhase`, `checkWinCondition`, `tallyVotes`）
- `src/game/phases/*.ts` 中的 `getPrompt()` 方法（用于生成 AI 提示词）
