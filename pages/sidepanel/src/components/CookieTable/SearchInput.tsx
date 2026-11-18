import { Input } from '@sync-your-cookie/ui';
import { Search, X } from 'lucide-react';
import { useState } from 'react';

export function SearchInput({ onEnter, label }: { onEnter: (value: string) => void; label: string }) {
  const [value, setValue] = useState('');
  const update = (next: string) => {
    setValue(next);
    onEnter(next.trim());
  };
  return (
    <div className="relative">
      <Search size={17} aria-hidden className="pointer-events-none absolute left-3 top-2.5 text-muted-foreground" />
      <Input
        value={value}
        onChange={event => update(event.target.value)}
        className="bg-card pl-9 pr-10"
        aria-label={label}
        placeholder={label}
      />
      {value && (
        <button
          type="button"
          aria-label="清除搜索"
          onClick={() => update('')}
          className="absolute right-1 top-1 rounded-md p-1.5 text-muted-foreground hover:bg-accent">
          <X size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}
