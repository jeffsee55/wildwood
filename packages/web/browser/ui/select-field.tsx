import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

// Compact composition for controlled settings fields; the registry Select owns
// keyboard navigation, labeling, focus, and portal behavior.
export function SelectField({
  value,
  onValueChange,
  options,
  label,
  disabled,
  id,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      disabled={disabled}
      items={options}
    >
      <SelectTrigger id={id} aria-label={label} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
