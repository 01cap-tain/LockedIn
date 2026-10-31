import { useMemo } from "react";
import {
  WheelPicker,
  WheelPickerWrapper,
  type WheelPickerOption,
} from "@ncdai/react-wheel-picker";
import "@ncdai/react-wheel-picker/style.css";

type WheelDatePickerProps = {
  includeTime?: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function partsFromValue(value: string) {
  const [datePart = "", timePart = ""] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const now = new Date();
  return {
    year: year || now.getFullYear(),
    month: month || now.getMonth() + 1,
    day: day || now.getDate(),
    hour: typeof hour === "number" && Number.isFinite(hour) ? hour : 12,
    minute: typeof minute === "number" && Number.isFinite(minute) ? minute : 0,
  };
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function options(
  values: number[],
  label: (value: number) => string = String,
): WheelPickerOption<number>[] {
  return values.map((value) => ({ value, label: label(value) }));
}

/**
 * Touch-friendly local date input. It only changes presentation; values keep
 * the same YYYY-MM-DD or YYYY-MM-DDTHH:mm format consumed by the app.
 */
export function WheelDatePicker({
  includeTime = false,
  label,
  onChange,
  value,
}: WheelDatePickerProps) {
  const selected = partsFromValue(value);
  const currentYear = new Date().getFullYear();
  const firstYear = Math.min(currentYear, selected.year);
  const years = useMemo(
    () => options(Array.from({ length: 11 }, (_, index) => firstYear + index)),
    [firstYear],
  );
  const months = useMemo(
    () => options(Array.from({ length: 12 }, (_, index) => index + 1), (month) => MONTHS[month - 1] ?? String(month)),
    [],
  );
  const dayCount = new Date(selected.year, selected.month, 0).getDate();
  const days = useMemo(
    () => options(Array.from({ length: dayCount }, (_, index) => index + 1)),
    [dayCount],
  );
  const hours = useMemo(
    () => options(Array.from({ length: 24 }, (_, index) => index), twoDigits),
    [],
  );
  const minutes = useMemo(
    () => options(Array.from({ length: 60 }, (_, index) => index), twoDigits),
    [],
  );

  function update(next: Partial<typeof selected>) {
    const merged = { ...selected, ...next };
    const maximumDay = new Date(merged.year, merged.month, 0).getDate();
    merged.day = Math.min(merged.day, maximumDay);
    const date = `${merged.year}-${twoDigits(merged.month)}-${twoDigits(merged.day)}`;
    onChange(includeTime ? `${date}T${twoDigits(merged.hour)}:${twoDigits(merged.minute)}` : date);
  }

  return (
    <div aria-label={label} className={`wheel-date-picker ${includeTime ? "with-time" : "date-only"}`} role="group">
      <div aria-hidden="true" className="wheel-date-labels">
        <span>Month</span><span>Day</span><span>Year</span>
        {includeTime && <><span>Hour</span><span>Min</span></>}
      </div>
      <WheelPickerWrapper className="wheel-date-columns">
        <WheelPicker infinite onValueChange={(month) => update({ month })} options={months} value={selected.month} visibleCount={16} />
        <WheelPicker infinite onValueChange={(day) => update({ day })} options={days} value={Math.min(selected.day, dayCount)} visibleCount={16} />
        <WheelPicker onValueChange={(year) => update({ year })} options={years} value={selected.year} visibleCount={16} />
        {includeTime && <WheelPicker infinite onValueChange={(hour) => update({ hour })} options={hours} value={selected.hour} visibleCount={16} />}
        {includeTime && <WheelPicker infinite onValueChange={(minute) => update({ minute })} options={minutes} value={selected.minute} visibleCount={16} />}
      </WheelPickerWrapper>
      <output className="wheel-date-output">
        {new Date(
          selected.year,
          selected.month - 1,
          selected.day,
          selected.hour,
          selected.minute,
        ).toLocaleString(undefined, includeTime
          ? { dateStyle: "medium", timeStyle: "short" }
          : { dateStyle: "medium" })}
      </output>
    </div>
  );
}
