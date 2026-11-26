import { Search, X } from 'lucide-react';
import { useState } from 'react';

export function SearchInput({ onEnter, label }: { onEnter: (value: string) => void; label: string }) {
  const [value, setValue] = useState('');
  const update = (next: string) => {
    setValue(next);
    onEnter(next.trim());
  };
  return (
    <div className="sp-search-bar">
      <Search
        size={14}
        aria-hidden
        className="pointer-events-none absolute left-0 text-[var(--sbo-faint)]"
      />
      <input
        type="text"
        value={value}
        onChange={event => update(event.target.value)}
        className="sp-search-input"
        aria-label={label}
        placeholder={label}
      />
      {value && (
        <button
          type="button"
          aria-label="清除搜索"
          onClick={() => update('')}
          className="sp-icon-link absolute right-0">
          <X size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}
