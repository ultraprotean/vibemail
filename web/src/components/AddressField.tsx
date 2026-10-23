'use client';

import { useId, type KeyboardEvent, type Ref } from 'react';
import { isValidAddress } from '@/lib/addresses';

interface AddressFieldProps {
  label: string;
  values: string[];
  text: string;
  onValuesChange: (values: string[]) => void;
  onTextChange: (text: string) => void;
  /** Reply mode: the address is fixed. */
  readOnly?: boolean;
  /** Mark malformed chips (set after a failed submit, not on blur). */
  showInvalid?: boolean;
  error?: string;
  inputRef?: Ref<HTMLInputElement>;
}

/** Split typed text on commas, semicolons and whitespace into candidate addresses. */
export function splitAddresses(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((part) => part.replace(/^<|>$/g, '').trim())
    .filter(Boolean);
}

export function AddressField({ label, values, text, onValuesChange, onTextChange, readOnly = false, showInvalid = false, error, inputRef }: AddressFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;

  function commit(raw: string) {
    const parts = splitAddresses(raw);
    if (parts.length === 0) return;
    const fresh = parts.filter((p) => !values.includes(p));
    if (fresh.length > 0) onValuesChange([...values, ...fresh]);
    onTextChange('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',' || event.key === ';' || event.key === ' ') {
      if (text.trim()) {
        event.preventDefault();
        commit(text);
      }
    } else if (event.key === 'Backspace' && text === '' && values.length > 0) {
      onValuesChange(values.slice(0, -1));
    }
  }

  return (
    <div className="field" data-invalid={Boolean(error)}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <div className="address-box" data-readonly={readOnly}>
        {values.map((address) => (
          <span key={address} className="address-chip" data-invalid={showInvalid && !isValidAddress(address)}>
            {address}
            {!readOnly && (
              <button type="button" aria-label={`Remove ${address}`} onClick={() => onValuesChange(values.filter((v) => v !== address))}>
                ×
              </button>
            )}
          </span>
        ))}
        {!readOnly && (
          <input
            id={id}
            ref={inputRef}
            type="text"
            inputMode="email"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={text}
            aria-describedby={error ? errorId : undefined}
            aria-invalid={Boolean(error)}
            onChange={(e) => {
              const next = e.target.value;
              if (/[,;]\s*$/.test(next)) commit(next);
              else onTextChange(next);
            }}
            onKeyDown={onKeyDown}
            onBlur={() => commit(text)}
          />
        )}
        {readOnly && <input id={id} className="visually-hidden" readOnly value={values.join(', ')} aria-label={`${label} (fixed for replies)`} />}
      </div>
      {error && (
        <p id={errorId} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
