import { useDraggable } from '@dnd-kit/core';
import { describeRulePlain } from '../recurrenceText';
import type { Card, Category, OwnerRow } from '../types';
import OwnerBadge from './OwnerBadge';

/**
 * Card face: title, cover picture, owner badges, recurrence, overdue, blocked
 * status and move readiness — all readable at a glance, without opening the card
 * or attempting a move.
 *
 * Every state carries text as well as colour: overdue = red left bar + "⚠
 * overdue", blocked = rose fill and ring + "⛔ blocked", so the two stay
 * distinguishable on a card that is both. Draggable via mouse/touch/keyboard.
 */
export default function CardTile({
  card,
  owners,
  coverUrl,
  category,
  blockers,
  readiness,
  onOpen,
  onCheckReadiness,
}: {
  card: Card;
  owners: OwnerRow[];
  coverUrl: string | null;
  category: Category | null;
  /** unresolved blockers on this card */
  blockers: { id: string; reason: string }[];
  /** before-leaving policies of the card's current column, and how many are ticked */
  readiness: { total: number; satisfied: number };
  onOpen: () => void;
  onCheckReadiness: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
    data: { type: 'card', card },
  });

  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 30 } : undefined;
  const blocked = blockers.length > 0;
  const outstanding = readiness.total - readiness.satisfied;
  const stateLabel = [blocked ? 'blocked' : null, card.is_overdue ? 'overdue' : null].filter(Boolean).join(', ');

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      role="button"
      aria-roledescription="Draggable card"
      aria-label={`Card: ${card.title}${stateLabel ? `, ${stateLabel}` : ''}`}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      className={`bg-white rounded-lg shadow-sm border border-slate-200 cursor-grab select-none hover:shadow-md hover:-translate-y-px transition-all ${
        isDragging ? 'opacity-60' : ''
      } ${card.is_overdue ? 'card-overdue' : ''} ${blocked ? 'card-blocked' : ''}`}
    >
      {category && (
        // category color accent: top bar + named chip below (color never alone)
        <div aria-hidden className="h-1.5 rounded-t-lg" style={{ background: category.color }} />
      )}
      {coverUrl && <img src={coverUrl} alt="" className={`w-full h-24 object-cover ${category ? '' : 'rounded-t-lg'}`} />}
      <div className="p-2">
        <p className="text-sm font-medium leading-snug">{card.title}</p>
        {category && (
          <span className="inline-flex items-center gap-1 text-xs text-gray-600 mt-1" aria-label={`Category: ${category.name}`}>
            <span aria-hidden className="w-2 h-2 rounded-full" style={{ background: category.color }} />
            {category.name}
          </span>
        )}
        {blocked && (
          <p className="text-xs font-semibold text-rose-800 mt-1 flex items-start gap-1" title={blockers.map((b) => b.reason).join('\n')}>
            <span aria-hidden>⛔</span>
            <span>
              blocked
              {blockers.length > 1 && ` (${blockers.length})`}: {blockers[0]!.reason}
            </span>
          </p>
        )}
        <div className="flex items-center mt-2 gap-1 min-h-[1.75rem] flex-wrap">
          {card.is_overdue && (
            <span className="text-xs font-semibold text-red-700 flex items-center gap-0.5" aria-hidden>
              ⚠ overdue
            </span>
          )}
          {readiness.total > 0 && (
            // before-leaving readiness at a glance — no move attempt needed
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onCheckReadiness();
              }}
              title={
                outstanding === 0
                  ? 'All before-leaving policies are ticked. Click to check the destination too.'
                  : `${outstanding} before-leaving ${outstanding === 1 ? 'policy is' : 'policies are'} outstanding. Click to review.`
              }
              aria-label={`Move readiness: ${readiness.satisfied} of ${readiness.total} before-leaving policies satisfied`}
              className={`text-xs rounded px-1 border ${
                outstanding === 0 ? 'text-emerald-800 border-emerald-300 bg-emerald-50' : 'text-amber-800 border-amber-300 bg-amber-50'
              }`}
            >
              ☑ {readiness.satisfied}/{readiness.total}
            </button>
          )}
          {card.recurrence_rule && (
            <span
              className="text-xs text-indigo-700 bg-indigo-50 rounded px-1"
              title={`Repeats ${describeRulePlain(card.recurrence_rule)}`}
              aria-label={`Recurring: ${describeRulePlain(card.recurrence_rule)}`}
            >
              🔁 {card.recurrence_status === 'awaiting_reopen' ? 'done, reopens later' : describeRulePlain(card.recurrence_rule)}
            </span>
          )}
          {!card.recurrence_rule && card.due_date && (
            <span className="text-xs text-gray-500" title="Due date">
              📅 {new Date(card.due_date).toLocaleDateString()}
            </span>
          )}
          <span className="ml-auto flex -space-x-1">
            {owners.map((o, i) => (
              <OwnerBadge key={i} owner={o} size={6} />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}
