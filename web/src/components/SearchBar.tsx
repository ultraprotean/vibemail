'use client';

import { forwardRef } from 'react';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
}

export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(function SearchBar({ value, onChange }, ref) {
  return (
    <form className="search" role="search" onSubmit={(e) => e.preventDefault()}>
      <label className="visually-hidden" htmlFor="mail-search">
        Search loaded mail
      </label>
      <span className="search-icon" aria-hidden="true" />
      <input
        id="mail-search"
        ref={ref}
        type="search"
        autoComplete="off"
        placeholder="Search mail"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            onChange('');
          }
        }}
      />
      {value ? (
        <button type="button" className="search-clear" aria-label="Clear search" onClick={() => onChange('')}>
          ×
        </button>
      ) : (
        <kbd className="search-hint" aria-hidden="true">
          Ctrl K
        </kbd>
      )}
    </form>
  );
});
