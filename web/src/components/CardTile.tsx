import { useDraggable } from '@dnd-kit/core';
import { describeRulePlain } from '../recurrenceText';
import type { Card, Category, OwnerRow } from '../types';
import OwnerBadge from './OwnerBadge';

/**
 * Card face: title, cover picture, owner badges, recurrence + overdue status —
 * all readable at a glance. Overdue = red border + tint + ⚠ text, not color
 * alone. Draggable via mouse/touch and keyboard (dnd-kit sensors).
 */
export default function CardTile({
  card,
  owners,
  coverUrl,
  category,
  onOpen,
}: {
  card: Card;
  owners: OwnerRow[];
  coverUrl: string | null;
  category: Category | null;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
    data: { type: 'card', card },
  });

  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 30 } : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      role="button"
      aria-roledescription="Draggable card"
      aria-label={`Card: ${card.title}${card.is_overdue ? ', overdue' : ''}`}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      className={`bg-white rounded-lg shadow-sm border border-slate-200 cursor-grab select-none hover:shadow-md hover:-translate-y-px transition-all ${
        isDragging ? 'opacity-60' : ''
      } ${card.is_overdue ? 'card-overdue' : ''}`}
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
        <div className="flex items-center mt-2 gap-1 min-h-[1.75rem]">
          {card.is_overdue && (
            <span className="text-xs font-semibold text-red-700 flex items-center gap-0.5" aria-hidden>
              ⚠ overdue
            </span>
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
