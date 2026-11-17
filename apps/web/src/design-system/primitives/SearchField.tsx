import { Search, X } from 'lucide-react';
import { IconButton } from './Button';

/** A labeled search input with a clear button, used by the apparatus library and the gallery. */
export function SearchField({ value, onChange, placeholder, label }: { value: string; onChange: (value: string) => void; placeholder?: string; label: string }) {
  return (
    <div className="astra-search">
      <Search className="astra-search__icon" aria-hidden />
      <input className="astra-search__input" type="search" aria-label={label} placeholder={placeholder} value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      {value && (
        <IconButton size="sm" tip="Clear search" tipPos="left" onClick={() => onChange('')}>
          <X />
        </IconButton>
      )}
    </div>
  );
}
