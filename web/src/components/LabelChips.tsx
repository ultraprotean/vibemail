'use client';

/**
 * Fixed chips, always in this order (docs/DESIGN_SPEC.md "Label filter bar"). The messages
 * response carries no labels (CONTRACT.md §6.3), so only All is live; the rest explain why.
 */
const FIXED_CHIPS = ['Starred', 'Archive', 'Trash'] as const;
const WHY = 'Needs backend support: the messages response does not include labels.';

interface LabelChipsProps {
  unreadOnly: boolean;
  onToggleUnread: (value: boolean) => void;
}

export function LabelChips({ unreadOnly, onToggleUnread }: LabelChipsProps) {
  return (
    <div className="chips" role="group" aria-label="Filter messages">
      <button type="button" className="chip" data-selected="true" aria-pressed="true">
        All
      </button>
      {FIXED_CHIPS.map((label) => (
        <span key={label} className="chip-wrap">
          <button type="button" className="chip" aria-disabled="true" aria-describedby={`why-${label}`} title={WHY} onClick={(e) => e.preventDefault()}>
            {label}
          </button>
          <span id={`why-${label}`} className="visually-hidden">
            {WHY}
          </span>
        </span>
      ))}
      <span className="chips-divider" aria-hidden="true" />
      <button
        type="button"
        className="chip chip-toggle"
        data-selected={unreadOnly}
        aria-pressed={unreadOnly}
        onClick={() => onToggleUnread(!unreadOnly)}
      >
        Unread
      </button>
    </div>
  );
}
