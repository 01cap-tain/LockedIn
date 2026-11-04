import { CalendarDays, ChevronLeft, ChevronRight, Clock3 } from "lucide-react";

type WheelDatePickerProps = {
  includeTime?: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
};

function partsFromValue(value: string) {
  const [datePart = "", timePart = ""] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const now = new Date();
  return {
    year: typeof year === "number" && year > 0 ? year : now.getFullYear(),
    month: typeof month === "number" && month > 0 ? month : now.getMonth() + 1,
    day: typeof day === "number" && day > 0 ? day : now.getDate(),
    hour: typeof hour === "number" && Number.isFinite(hour) ? hour : 12,
    minute: typeof minute === "number" && Number.isFinite(minute) ? minute : 0,
  };
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Compact, touch-friendly local date selector. Presentation changed from a
 * multi-column wheel, but the app still receives the same local date value.
 */
export function WheelDatePicker({ includeTime = false, label, onChange, value }: WheelDatePickerProps) {
  const selected = partsFromValue(value);
  const selectedDate = new Date(selected.year, selected.month - 1, selected.day, selected.hour, selected.minute);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(selectedDate);
    date.setDate(selectedDate.getDate() + index - 3);
    return date;
  });

  function emit(date: Date, hour = selected.hour, minute = selected.minute) {
    const dateValue = `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
    onChange(includeTime ? `${dateValue}T${twoDigits(hour)}:${twoDigits(minute)}` : dateValue);
  }

  function moveWeek(offset: number) {
    const next = new Date(selectedDate);
    next.setDate(next.getDate() + offset * 7);
    emit(next);
  }

  return (
    <div aria-label={label} className={`calendar-date-picker ${includeTime ? "with-time" : "date-only"}`} role="group">
      <header className="calendar-picker-header">
        <span><CalendarDays aria-hidden="true" size={18} strokeWidth={1.6} />Choose date</span>
        <div className="calendar-month-controls">
          <button aria-label="Previous week" onClick={() => moveWeek(-1)} type="button"><ChevronLeft aria-hidden="true" size={18} strokeWidth={1.6} /></button>
          <strong>{selectedDate.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</strong>
          <button aria-label="Next week" onClick={() => moveWeek(1)} type="button"><ChevronRight aria-hidden="true" size={18} strokeWidth={1.6} /></button>
        </div>
      </header>
      <div className="calendar-day-strip">
        {days.map((date) => {
          const active = date.toDateString() === selectedDate.toDateString();
          return (
            <button aria-pressed={active} className={active ? "active" : ""} key={date.toISOString()} onClick={() => emit(date)} type="button">
              <span>{date.toLocaleDateString(undefined, { weekday: "short" })}</span>
              <strong>{date.getDate()}</strong>
            </button>
          );
        })}
      </div>
      <div className="calendar-indicators" aria-hidden="true">
        {days.map((date) => <i className={date.toDateString() === selectedDate.toDateString() ? "active" : ""} key={date.toISOString()} />)}
      </div>
      {includeTime && (
        <label className="calendar-time-field">
          <span><Clock3 aria-hidden="true" size={17} strokeWidth={1.6} />Time</span>
          <input
            aria-label={`${label} time`}
            onChange={(event) => {
              const time = event.target.value.split(":").map(Number);
              const hour = time[0] ?? selected.hour;
              const minute = time[1] ?? selected.minute;
              emit(selectedDate, hour, minute);
            }}
            type="time"
            value={`${twoDigits(selected.hour)}:${twoDigits(selected.minute)}`}
          />
        </label>
      )}
      <output className="calendar-date-output">
        {selectedDate.toLocaleString(undefined, includeTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" })}
      </output>
    </div>
  );
}
