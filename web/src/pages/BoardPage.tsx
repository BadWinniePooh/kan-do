import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { get, post } from '../api';
import type { BoardDetail, Card, ColumnPolicy, MoveRequirements, OwnerRow } from '../types';
import { useBoardRealtime } from '../realtime';
import CardTile from '../components/CardTile';
import CardModal from '../components/CardModal';
import ColumnEditor from '../components/ColumnEditor';
import BoardSettings from '../components/BoardSettings';
import MovePolicyDialog from '../components/MovePolicyDialog';
import { BoardSkeleton } from '../components/Loading';
import { useDismiss } from '../useDismiss';

type BoardDetailWithCovers = BoardDetail & { covers: Record<string, string> };

export default function BoardPage() {
  const { boardId } = useParams<{ boardId: string }>();
  const qc = useQueryClient();
  useBoardRealtime(boardId);

  const { data, isLoading, error } = useQuery<BoardDetailWithCovers>({
    queryKey: ['board', boardId],
    queryFn: () => get(`/api/boards/${boardId}`),
    enabled: !!boardId,
  });

  const [openCard, setOpenCard] = useState<string | null>(null);
  const [dragging, setDragging] = useState<Card | null>(null);
  const [editColumns, setEditColumns] = useState(false);
  const [boardSettings, setBoardSettings] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [newCardCol, setNewCardCol] = useState<string | null>(null);
  const [gatedMove, setGatedMove] = useState<{ card: Card; laneId: string | null; requirements: MoveRequirements } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const ownersByCard = useMemo(() => {
    const m = new Map<string, OwnerRow[]>();
    for (const o of data?.owners ?? []) {
      const list = m.get(o.card_id) ?? [];
      list.push(o);
      m.set(o.card_id, list);
    }
    return m;
  }, [data?.owners]);

  const policiesByColumn = useMemo(() => {
    const m = new Map<string, ColumnPolicy[]>();
    for (const p of data?.policies ?? []) {
      const list = m.get(p.column_id) ?? [];
      list.push(p);
      m.set(p.column_id, list);
    }
    return m;
  }, [data?.policies]);

  const move = useMutation({
    mutationFn: (v: { cardId: string; toColumnId: string; laneId: string | null }) =>
      post(`/api/cards/${v.cardId}/move`, { toColumnId: v.toColumnId, laneId: v.laneId, position: Date.now() }),
    onError: (e) => setMoveError(`Move failed: ${e.message}. The board has been restored.`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  });

  const onDragEnd = async (e: DragEndEvent) => {
    setDragging(null);
    const card = e.active.data.current?.card as Card | undefined;
    const target = e.over?.data.current as { columnId: string; laneId: string | null } | undefined;
    if (!card || !target) return;
    if (card.column_id === target.columnId && card.lane_id === target.laneId) return;
    setMoveError(null);

    // A column change may be gated by policies or the no-backwards rule. Ask
    // first so the checklist is presented up front rather than after a refusal;
    // a same-column reorder and an ungated move skip straight through.
    if (card.column_id !== target.columnId) {
      let requirements: MoveRequirements;
      try {
        requirements = await get<MoveRequirements>(
          `/api/cards/${card.id}/move-requirements?toColumnId=${target.columnId}`,
        );
      } catch (err) {
        setMoveError(`Move failed: ${err instanceof Error ? err.message : 'unknown error'}. The board is unchanged.`);
        return;
      }
      if (requirements.backwards || requirements.applicable.length > 0) {
        setGatedMove({ card, laneId: target.laneId, requirements });
        return;
      }
    }

    // optimistic: card appears in the target instantly; server confirms or we roll back
    qc.setQueryData<BoardDetailWithCovers>(['board', boardId], (old) =>
      old
        ? {
            ...old,
            cards: old.cards.map((c) =>
              c.id === card.id ? { ...c, column_id: target.columnId, lane_id: target.laneId } : c,
            ),
          }
        : old,
    );
    move.mutate({ cardId: card.id, toColumnId: target.columnId, laneId: target.laneId });
  };

  if (isLoading) return <BoardSkeleton />;
  if (error || !data) return <p className="p-6 text-red-700" role="alert">⚠ Could not load board: {String(error)}</p>;

  const lanes = data.lanes.length ? data.lanes : [{ id: null as string | null, name: '', position: 0 }];
  // safety net for the lane invariant: a card whose lane is unknown (races,
  // stale cache) renders in the first lane instead of disappearing
  const laneIds = new Set(data.lanes.map((l) => l.id));
  const effectiveLane = (c: Card): string | null =>
    data.lanes.length === 0 ? null : c.lane_id && laneIds.has(c.lane_id) ? c.lane_id : data.lanes[0]!.id;

  return (
    <div className="p-4 h-full">
      <div className="flex items-center gap-3 mb-3">
        <h1 className="text-xl font-bold">{data.board.name}</h1>
        <button onClick={() => setEditColumns(true)} className="text-sm border rounded px-2 py-1 bg-white hover:bg-gray-50">
          ⚙ Columns & lanes
        </button>
        <button onClick={() => setBoardSettings(true)} className="text-sm border rounded px-2 py-1 bg-white hover:bg-gray-50">
          👥 Board settings
        </button>
      </div>
      {moveError && (
        <p role="alert" className="mb-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
          ⚠ {moveError}
        </p>
      )}

      <DndContext
        sensors={sensors}
        onDragStart={(e: DragStartEvent) => setDragging((e.active.data.current?.card as Card) ?? null)}
        onDragEnd={(e) => void onDragEnd(e)}
        onDragCancel={() => setDragging(null)}
      >
        <div className="space-y-6">
          {lanes.map((lane) => (
            <section key={lane.id ?? 'default'} aria-label={lane.name || 'Board'}>
              {lane.name && <h2 className="font-semibold text-gray-600 text-sm mb-1 uppercase tracking-wide">{lane.name}</h2>}
              <div className="flex gap-3 overflow-x-auto pb-2">
                {data.columns.map((col) => (
                  <ColumnDrop key={col.id} columnId={col.id} laneId={lane.id}>
                    <header className="flex items-center gap-2 px-1 mb-2">
                      <h3 className="font-semibold text-sm">{col.name}</h3>
                      {col.semantic && (
                        <span className="text-xs text-gray-400 border rounded px-1" title={`Mapped to "${col.semantic}"`}>
                          {col.semantic}
                        </span>
                      )}
                      {(() => {
                        const ps = policiesByColumn.get(col.id) ?? [];
                        if (ps.length === 0) return null;
                        const enter = ps.filter((p) => p.kind === 'enter').length;
                        const leave = ps.length - enter;
                        return (
                          <span
                            className="text-xs text-amber-800 border border-amber-300 bg-amber-50 rounded px-1"
                            title={`${enter} policy check(s) before entering, ${leave} before leaving`}
                          >
                            ☑ {ps.length}
                          </span>
                        );
                      })()}
                      <button
                        aria-label={`Add card to ${col.name}`}
                        onClick={() => setNewCardCol(col.id)}
                        className="ml-auto text-gray-400 hover:text-gray-700"
                      >
                        +
                      </button>
                    </header>
                    <div className="space-y-2 min-h-[3rem]">
                      {data.cards
                        .filter((c) => c.column_id === col.id && effectiveLane(c) === lane.id)
                        .sort((a, b) => a.position - b.position)
                        .map((card) => (
                          <CardTile
                            key={card.id}
                            card={card}
                            owners={ownersByCard.get(card.id) ?? []}
                            coverUrl={data.covers[card.id] ?? null}
                            category={data.categories.find((cat) => cat.id === card.category_id) ?? null}
                            onOpen={() => setOpenCard(card.id)}
                          />
                        ))}
                    </div>
                    {newCardCol === col.id && (
                      <QuickAdd
                        boardId={boardId!}
                        columnId={col.id}
                        laneId={lane.id}
                        onDone={() => {
                          setNewCardCol(null);
                          void qc.invalidateQueries({ queryKey: ['board', boardId] });
                        }}
                      />
                    )}
                  </ColumnDrop>
                ))}
              </div>
            </section>
          ))}
        </div>
        <DragOverlay>
          {dragging && (
            <div className="bg-white rounded-lg shadow-lg border p-2 w-64 rotate-2">
              <p className="text-sm font-medium">{dragging.title}</p>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {gatedMove && (
        <MovePolicyDialog
          cardId={gatedMove.card.id}
          cardTitle={gatedMove.card.title}
          laneId={gatedMove.laneId}
          requirements={gatedMove.requirements}
          onClose={() => {
            setGatedMove(null);
            void qc.invalidateQueries({ queryKey: ['board', boardId] });
          }}
          onMoved={() => {
            setGatedMove(null);
            void qc.invalidateQueries({ queryKey: ['board', boardId] });
          }}
        />
      )}

      {openCard && <CardModal cardId={openCard} board={data} onClose={() => setOpenCard(null)} />}
      {editColumns && <ColumnEditor board={data} onClose={() => setEditColumns(false)} />}
      {boardSettings && <BoardSettings board={data} onClose={() => setBoardSettings(false)} />}
    </div>
  );
}

function ColumnDrop({ columnId, laneId, children }: { columnId: string; laneId: string | null; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `${columnId}:${laneId ?? 'none'}`,
    data: { columnId, laneId },
  });
  return (
    <div
      ref={setNodeRef}
      className={`board-column p-2 w-64 shrink-0 transition-all ${isOver ? '!bg-indigo-100 ring-2 ring-indigo-400' : ''}`}
    >
      {children}
    </div>
  );
}

function QuickAdd({
  boardId,
  columnId,
  laneId,
  onDone,
}: {
  boardId: string;
  columnId: string;
  laneId: string | null;
  onDone: () => void;
}) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const formRef = useDismiss<HTMLFormElement>(onDone);
  const create = useMutation({
    mutationFn: () => post('/api/cards', { boardId, columnId, laneId, title: title.trim() }),
    onSuccess: onDone,
    onError: (e) => setError(e.message),
  });
  return (
    <form
      ref={formRef}
      className="mt-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() && !create.isPending) create.mutate();
      }}
    >
      <label className="sr-only" htmlFor={`qa-${columnId}`}>
        New card title
      </label>
      <input
        id={`qa-${columnId}`}
        autoFocus
        value={title}
        disabled={create.isPending}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Card title, Enter to add"
        className="w-full border rounded px-2 py-1 text-sm disabled:opacity-50"
      />
      {error && (
        <p role="alert" className="text-xs text-red-700 mt-1">
          ⚠ {error}
        </p>
      )}
    </form>
  );
}
