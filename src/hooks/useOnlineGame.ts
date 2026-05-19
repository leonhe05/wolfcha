"use client";

/**
 * useOnlineGame - 联机游戏模式 Hook
 *
 * 职责：
 * 1. 通过 Socket.IO 连接后端游戏服务器
 * 2. 接收后端广播的完整 GameState，直接替换本地状态
 * 3. 将人类玩家操作通过 Socket.IO 发送给后端
 * 4. 暴露与 useGameLogic 兼容的 API 给 UI 组件
 *
 * 设计原则：
 * - 前端只做展示层，所有权威状态来自后端
 * - 薄前端：收到 STATE_UPDATE 后直接 setGameState(receivedState)
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useAtom } from "jotai";
import io from "socket.io-client";
import type { Socket } from "socket.io-client";
import { toast } from "sonner";
import { useLocalStorageState } from "ahooks";

import {
  gameStateAtom,
  myPlayerIdAtom,
  humanPlayerAtom,
  isGameInProgress,
} from "@/store/game-machine";
import { useDialogueManager, type DialogueState } from "./useDialogueManager";
import type { GameState, StartGameOptions } from "@/types/game";

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL;
if (!SOCKET_URL) {
  throw new Error("Missing NEXT_PUBLIC_SOCKET_URL");
}

// Re-export for backward compatibility
export type { DialogueState };

export function useOnlineGame() {
  // ============================================
  // 基础状态
  // ============================================
  const [humanName, setHumanName] = useLocalStorageState<string>("wolfcha_human_name", {
    defaultValue: "",
  });
  const [gameStarted, setGameStarted] = useState(false);
  const [gameState, setGameState] = useAtom(gameStateAtom);
  const [isLoading, setIsLoading] = useState(false);
  const [inputText, setInputText] = useState("");
  const [showTable, setShowTable] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const [, setMyPlayerId] = useAtom(myPlayerIdAtom);
  const [humanPlayer] = useAtom(humanPlayerAtom);

  // 从 DialogueManager 获取状态和操作
  const {
    currentDialogue,
    isWaitingForAI,
    waitingForNextRound,
    setIsWaitingForAI,
    setWaitingForNextRound,
    setDialogue,
    markCurrentSegmentCompleted,
    isCurrentSegmentCompleted,
    shouldAutoAdvanceToNextAI,
  } = useDialogueManager();

  // Socket.IO 连接
  const socketRef = useRef<Socket | null>(null);
  const isConnectingRef = useRef(false);

  // ============================================
  // Socket.IO 连接与事件监听
  // ============================================
  useEffect(() => {
    if (socketRef.current || isConnectingRef.current) return;
    isConnectingRef.current = true;

    const socket = io(SOCKET_URL, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socket.on("connect", () => {
      console.info("[wolfcha] Socket connected:", socket.id);
      // 连接成功后自动加入房间（临时房间 ID，后续可由 UI 传入）
      const roomId = "default";
      const playerName = humanName || "玩家" + Math.floor(Math.random() * 1000);
      socket.emit(
        "JOIN_ROOM",
        { roomId, playerName },
        (response: { yourPlayerId?: string; error?: string }) => {
          if (response?.error) {
            toast.error(response.error);
            return;
          }
          if (response?.yourPlayerId) {
            setMyPlayerId(response.yourPlayerId);
          }
        }
      );
    });

    socket.on("disconnect", (reason) => {
      console.info("[wolfcha] Socket disconnected:", reason);
    });

    socket.on("connect_error", (err) => {
      console.error("[wolfcha] Socket connection error:", err.message);
      toast.error("连接游戏服务器失败，请检查网络");
    });

    // 核心：全量状态更新
    socket.on("STATE_UPDATE", (newState: GameState) => {
      setGameState(newState);
      setIsWaitingForAI(false);

      // 如果后端推送了已开始的游戏状态，自动展示桌面
      if (isGameInProgress(newState) && newState.players.length > 0) {
        setGameStarted(true);
        setShowTable(true);
      }
    });

    // 发言开始
    socket.on("SPEECH_START", (payload: { playerName: string; content: string; isStreaming?: boolean }) => {
      setDialogue(payload.playerName, payload.content, payload.isStreaming ?? false);
    });

    // 流式发言片段
    socket.on("SPEECH_CHUNK", (payload: { chunk: string }) => {
      // 追加到当前对话（如果支持流式）
      // TODO: 在 DialogueManager 中追加支持
      setDialogue(currentDialogue?.speaker ?? "", (currentDialogue?.text ?? "") + payload.chunk, true);
    });

    // 发言结束
    socket.on("SPEECH_END", () => {
      markCurrentSegmentCompleted();
    });

    // 系统消息（旁白）
    socket.on("SYSTEM_MESSAGE", (payload: { content: string; playNarrator?: string }) => {
      // 旁白直接显示在对话框中
      if (payload.content) {
        setDialogue("系统", payload.content, false);
      }
    });

    // 私有行动结果（如预言家查验）
    socket.on("ACTION_RESULT", (payload: { actionType: string; result: unknown }) => {
      // 显示在对话框中
      setDialogue("系统", JSON.stringify(payload), false);
    });

    // 房间信息（等待阶段）
    socket.on("ROOM_INFO", () => {
      // TODO: 更新房间 UI
    });

    // 游戏结束
    socket.on("GAME_END", () => {
      setIsWaitingForAI(false);
      setWaitingForNextRound(false);
    });

    // 错误提示
    socket.on("ERROR", (payload: { message: string }) => {
      toast.error(payload.message);
      setIsWaitingForAI(false);
    });

    socketRef.current = socket;
    isConnectingRef.current = false;

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
    // Socket 连接只在挂载时建立一次，避免重连时重复加入房间
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============================================
  // 通用发送动作封装
  // ============================================
  const sendAction = useCallback(<T,>(event: string, payload: T) => {
    if (!socketRef.current?.connected) {
      toast.error("未连接到游戏服务器");
      return;
    }
    setIsWaitingForAI(true);
    socketRef.current.emit(event, payload);
  }, [setIsWaitingForAI]);

  // ============================================
  // 游戏操作（只发送，不计算状态）
  // ============================================

  /** 开始游戏 */
  const startGame = useCallback((options?: Partial<StartGameOptions>) => {
    // 联机模式下，游戏配置由后端/房主管理，前端发送 START_GAME 即可
    // options 保留以兼容旧 API
    void options;
    sendAction("START_GAME", {});
  }, [sendAction]);
  setGameStarted(true);
  setShowTable(true);
  /** 角色揭示后继续 */
  const continueAfterRoleReveal = useCallback(() => {
    sendAction("CONTINUE", {});
  }, [sendAction]);

  /** 重启游戏（断开并重连） */
  const restartGame = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current.connect();
    }
    setGameStarted(false);
    setShowTable(false);
    setMyPlayerId(null);
    setGameState({
      ...gameState,
      phase: "LOBBY",
      players: [],
      messages: [],
    } as GameState);
  }, [setGameState, setMyPlayerId, gameState]);

  /** 人类发言 */
  const handleHumanSpeech = useCallback(() => {
    const content = inputText.trim();
    if (!content || !humanPlayer) return;
    sendAction("SPEECH", { content });
    setInputText("");
  }, [inputText, humanPlayer, sendAction]);

  /** 结束发言（人类说完后主动通知后端） */
  const handleFinishSpeaking = useCallback(async () => {
    sendAction("FINISH_SPEAKING", {});
  }, [sendAction]);

  /** 警长竞选报名 */
  const handleBadgeSignup = useCallback(
    (wants: boolean) => {
      sendAction("BADGE_SIGNUP", { wants });
    },
    [sendAction]
  );

  /** 投票 */
  const handleHumanVote = useCallback(
    (targetSeat: number) => {
      sendAction("VOTE", { targetSeat });
    },
    [sendAction]
  );

  /** 夜间行动 */
  const handleNightAction = useCallback(
    (targetSeat: number, witchAction?: "save" | "poison" | "pass") => {
      sendAction("NIGHT_ACTION", { targetSeat, witchAction });
    },
    [sendAction]
  );

  /** 警长移交 */
  const handleHumanBadgeTransfer = useCallback(
    (targetSeat: number) => {
      sendAction("BADGE_TRANSFER", { targetSeat });
    },
    [sendAction]
  );

  /** 白狼王自爆 */
  const handleWhiteWolfKingBoom = useCallback(() => {
    // 联机模式下由后端决定自爆后是否带人，前端通知自爆即可
    sendAction("WWK_BOOM", {});
  }, [sendAction]);

  /** 推进下一轮 / 继续 */
  const handleNextRound = useCallback(async () => {
    sendAction("CONTINUE", {});
  }, [sendAction]);

  /** 推进对话（按键跳过当前 AI 发言） */
  const advanceSpeech = useCallback(async () => {
    // 联机模式下，前端通知后端"我已看完"
    sendAction("SKIP_SPEECH", {});
    return {
      finished: true,
      shouldAdvanceToNextSpeaker: false,
      shouldAutoAdvanceToNextAI: false,
    };
  }, [sendAction]);

  /** 滚动到底部（兼容旧 API，联机模式下无操作） */
  const scrollToBottom = useCallback(() => {
    // no-op
  }, []);

  /** 暂停/继续（兼容旧 API，联机模式下无操作） */
  const togglePause = useCallback(() => {
    // no-op
  }, []);

  // ============================================
  // 派生状态
  // ============================================
  const isNight = gameState.phase.includes("NIGHT");

  // ============================================
  // 返回 API（与 useGameLogic 兼容）
  // ============================================
  return {
    // State
    humanName: humanName || "",
    setHumanName,
    gameStarted,
    gameState,
    isLoading,
    isWaitingForAI,
    waitingForNextRound,
    currentDialogue,
    inputText,
    setInputText,
    showTable,
    logRef,
    humanPlayer,
    isNight,

    // Actions
    startGame,
    continueAfterRoleReveal,
    restartGame,
    handleHumanSpeech,
    handleFinishSpeaking,
    handleBadgeSignup,
    handleHumanVote,
    handleNightAction,
    handleHumanBadgeTransfer,
    handleWhiteWolfKingBoom,
    handleNextRound,
    scrollToBottom,
    advanceSpeech,
    togglePause,
    markCurrentSegmentCompleted,
    isCurrentSegmentCompleted,
    shouldAutoAdvanceToNextAI,
  };
}
