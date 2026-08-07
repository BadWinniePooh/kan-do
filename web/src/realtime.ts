import { io, type Socket } from 'socket.io-client';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(import.meta.env.VITE_API_URL ?? '/', { withCredentials: true });
  }
  return socket;
}

/** Live board updates: join the board room, refetch on any board event. */
export function useBoardRealtime(boardId: string | undefined): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!boardId) return;
    const s = getSocket();
    s.emit('board:join', boardId);
    const onEvent = () => {
      void qc.invalidateQueries({ queryKey: ['board', boardId] });
      void qc.invalidateQueries({ queryKey: ['card'] });
    };
    s.on('board:event', onEvent);
    return () => {
      s.emit('board:leave', boardId);
      s.off('board:event', onEvent);
    };
  }, [boardId, qc]);
}

export function useNotificationRealtime(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const s = getSocket();
    const onEvent = () => void qc.invalidateQueries({ queryKey: ['notifications'] });
    s.on('user:event', onEvent);
    return () => {
      s.off('user:event', onEvent);
    };
  }, [qc]);
}
