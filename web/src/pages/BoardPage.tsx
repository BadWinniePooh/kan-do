import { useMemo, useRef, useState } from 'react';
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
import CardReadiness from '../components/CardReadiness';
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
  // the quick-add form belongs to one column AND one lane — a board with
  // swimlanes has a separate drop cell per pair
  const [newCardAt, setNewCardAt] = useState<{ columnId: string; laneId: string } | null>(null);
  const [gatedMove, setGatedMove] = useState<{ card: Card; laneId: string; requirements: MoveRequirements } | null>(null);
  const [readinessCard, setReadinessCard] = useState<Card | null>(null);

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

  const blockersByCard = useMemo(() => {
    const m = new Map<string, { id: string; reason: string }[]>();
    for (const b of data?.blockers ?? []) {
      const list = m.get(b.card_id) ?? [];
      list.push({ id: b.id, reason: b.reason });
      m.set(b.card_id, list);
    }
    return m;
  }, [data?.blockers]);

  /**
   * Move readiness per card, computed from data the board already has: how many
   * of the current column's before-leaving policies are ticked. Lets a user see
   * whether a card is ready before they ever pull it.
   */
  const readinessOf = useMemo(() => {
    const ticked = new Set((data?.policyProgress ?? []).map((p) => `${p.card_id}:${p.policy_id}`));
    return (card: Card) => {
      const leaving = (policiesByColumn.get(card.column_id) ?? []).filter((p) => p.kind === 'leave');
      return { total: leaving.length, satisfied: leaving.filter((p) => ticked.has(`${card.id}:${p.id}`)).length };
    };
  }, [data?.policyProgress, policiesByColumn]);

  const move = useMutation({
    mutationFn: (v: { cardId: string; toColumnId: string; laneId: string }) =>
      post(`/api/cards/${v.cardId}/move`, { toColumnId: v.toColumnId, laneId: v.laneId, position: Date.now() }),
    onError: (e) => setMoveError(`Move failed: ${e.message}. The board has been restored.`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  });

  const onDragEnd = async (e: DragEndEvent) => {
    setDragging(null);
    const card = e.active.data.current?.card as Card | undefined;
    const target = e.over?.data.current as { columnId: string; laneId: string } | undefined;
    if (!card || !target) return;
    if (card.column_id === target.columnId) return;
    setMoveError(null);

    // A column change may be gated by policies, the no-backwards rule, the
    // no-lane-change rule, or need a discard reason. Ask first so the dialog is
    // presented up front rather than after a refusal; ungated moves go straight
    // through.
    let requirements: MoveRequirements;
    try {
      requirements = await get<MoveRequirements>(`/api/cards/${card.id}/move-requirements?toColumnId=${target.columnId}`);
    } catch (err) {
      setMoveError(`Move failed: ${err instanceof Error ? err.message : 'unknown error'}. The board is unchanged.`);
      return;
    }
    if (
      requirements.backwards ||
      requirements.laneMove ||
      requirements.discarding ||
      requirements.activeBlockers.length > 0 ||
      requirements.applicable.length > 0
    ) {
      setGatedMove({ card, laneId: target.laneId, requirements });
      return;
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

  // columns belong to lanes now, so each lane renders its OWN strip — two lanes
  // on one board can have entirely different columns in a different order
  const columnsByLane = new Map<string, typeof data.columns>();
  for (const col of data.columns) {
    const list = columnsByLane.get(col.lane_id) ?? [];
    list.push(col);
    columnsByLane.set(col.lane_id, list);
  }

  return (
    <div className="p-4 h-full">
      <div className="flex items-center gap-3 mb-3">
        <h1 className="text-xl font-bold">{data.board.name}</h1>
        <button onClick={() => setEditColumns(true)} className="text-sm border rounded px-2 py-1 bg-white hover:bg-gray-50">
          ⚙ Lanes & columns
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
          {data.lanes.map((lane) => (
            <section key={lane.id} aria-label={lane.name}>
              <h2 className="font-semibold text-gray-600 text-sm mb-1 uppercase tracking-wide">{lane.name}</h2>
              <div className="flex gap-3 overflow-x-auto pb-2">
                {(columnsByLane.get(lane.id) ?? []).map((col) => (
                  <ColumnDrop key={col.id} columnId={col.id} laneId={lane.id} discard={col.semantic === 'discard'}>
                    <header className="flex items-center gap-2 px-1 mb-2">
                      <h3 className="font-semibold text-sm">{col.name}</h3>
                      {col.semantic && (
                        <span
                          className={`text-xs border rounded px-1 ${
                            col.semantic === 'discard' ? 'text-stone-600 border-stone-300 bg-stone-100' : 'text-gray-400'
                          }`}
                          title={
                            col.semantic === 'discard'
                              ? 'Discarded: finished but reverted — not counted as completed work'
                              : `Mapped to "${col.semantic}"`
                          }
                        >
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
                        aria-label={`Add card to ${col.name} in ${lane.name}`}
                        onClick={() => setNewCardAt({ columnId: col.id, laneId: lane.id })}
                        className="ml-auto text-gray-400 hover:text-gray-700"
                      >
                        +
                      </button>
                    </header>
                    <div className="space-y-2 min-h-[3rem]">
                      {data.cards
                        .filter((c) => c.column_id === col.id)
                        .sort((a, b) => a.position - b.position)
                        .map((card) => (
                          <CardTile
                            key={card.id}
                            card={card}
                            owners={ownersByCard.get(card.id) ?? []}
                            coverUrl={data.covers[card.id] ?? null}
                            category={data.categories.find((cat) => cat.id === card.category_id) ?? null}
                            blockers={blockersByCard.get(card.id) ?? []}
                            readiness={readinessOf(card)}
                            onOpen={() => setOpenCard(card.id)}
                            onCheckReadiness={() => setReadinessCard(card)}
                          />
                        ))}
                    </div>
                    {newCardAt?.columnId === col.id && newCardAt.laneId === lane.id && (
                      <QuickAdd
                        boardId={boardId!}
                        columnId={col.id}
                        laneId={lane.id}
                        onAdded={() => void qc.invalidateQueries({ queryKey: ['board', boardId] })}
                        onClose={() => setNewCardAt(null)}
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

      {readinessCard && (
        <CardReadiness
          cardId={readinessCard.id}
          cardTitle={readinessCard.title}
          currentColumnId={readinessCard.column_id}
          laneColumns={data.columns.filter((c) => c.lane_id === readinessCard.lane_id)}
          onClose={() => setReadinessCard(null)}
          onSaved={() => void qc.invalidateQueries({ queryKey: ['board', boardId] })}
        />
      )}

      {openCard && <CardModal cardId={openCard} board={data} onClose={() => setOpenCard(null)} />}
      {editColumns && <ColumnEditor board={data} onClose={() => setEditColumns(false)} />}
      {boardSettings && <BoardSettings board={data} onClose={() => setBoardSettings(false)} />}
    </div>
  );
}

function ColumnDrop({
  columnId,
  laneId,
  discard,
  children,
}: {
  columnId: string;
  laneId: string;
  discard?: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${columnId}:${laneId}`, data: { columnId, laneId } });
  return (
    <div
      ref={setNodeRef}
      className={`board-column p-2 w-64 shrink-0 transition-all ${discard ? 'opacity-80 bg-stone-50' : ''} ${
        isOver ? '!bg-indigo-100 ring-2 ring-indigo-400' : ''
      }`}
    >
      {children}
    </div>
  );
}

/**
 * Inline card entry. Adding does NOT close the form: the field clears and keeps
 * focus so titles can be typed and Entered back to back. Only an explicit
 * dismiss (Escape, or a click outside) closes it.
 *
 * The field is never disabled while a create is in flight — that would steal
 * focus mid-run. It clears optimistically instead, and a failed create hands
 * the title back if the user has not started typing the next one.
 */
function QuickAdd({
  boardId,
  columnId,
  laneId,
  onAdded,
  onClose,
}: {
  boardId: string;
  columnId: string;
  laneId: string | null;
  /** a card landed — refresh the board, but stay open */
  onAdded: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useDismiss<HTMLFormElement>(onClose);
  const create = useMutation({
    mutationFn: (t: string) => post('/api/cards', { boardId, columnId, laneId, title: t }),
    onSuccess: () => {
      inputRef.current?.focus();
      onAdded();
    },
    onError: (e, t) => {
      setError(e.message);
      // don't clobber whatever the user has typed since
      setTitle((current) => current || t);
    },
  });
  return (
    <form
      ref={formRef}
      className="mt-2"
      onSubmit={(e) => {
        e.preventDefault();
        const t = title.trim();
        if (!t) return;
        setTitle('');
        setError(null);
        create.mutate(t);
      }}
    >
      <label className="sr-only" htmlFor={`qa-${columnId}`}>
        New card title
      </label>
      <input
        id={`qa-${columnId}`}
        ref={inputRef}
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Card title, Enter to add"
        className="w-full border rounded px-2 py-1 text-sm"
      />
      {error && (
        <p role="alert" className="text-xs text-red-700 mt-1">
          ⚠ {error}
        </p>
      )}
    </form>
  );
}
