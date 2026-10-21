import Calendar from "react-calendar";
import "react-calendar/dist/Calendar.css";
import { CalendarCheck2, Flame } from "lucide-react";

import type { ActivityItem } from "../lib/contracts";

interface SavingsCalendarProps {
  activity: ActivityItem[];
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function SavingsCalendar({ activity }: SavingsCalendarProps) {
  const activitiesByDay = new Map<string, ActivityItem[]>();
  const depositDays = new Set<string>();
  for (const item of activity) {
    const key = dateKey(item.timestamp);
    activitiesByDay.set(key, [...(activitiesByDay.get(key) ?? []), item]);
    if (item.title === "Deposit confirmed") depositDays.add(key);
  }

  const sortedDepositDates = [...depositDays]
    .map((key) => {
      const [year, month, day] = key.split("-").map(Number);
      return new Date(year!, month!, day!);
    })
    .sort((left, right) => right.getTime() - left.getTime());
  let streak = sortedDepositDates.length > 0 ? 1 : 0;
  for (let index = 1; index < sortedDepositDates.length; index += 1) {
    const gap =
      (sortedDepositDates[index - 1]!.getTime() -
        sortedDepositDates[index]!.getTime()) /
      86_400_000;
    if (gap !== 1) break;
    streak += 1;
  }

  return (
    <section className="savings-calendar" aria-label="Monthly savings activity">
      <span className="sticky-tape" aria-hidden="true" />
      <div className="calendar-heading">
        <div>
          <span className="eyebrow">Savings rhythm</span>
          <h3>This month</h3>
        </div>
        <span className="streak-count"><Flame aria-hidden="true" size={15} /><strong>{streak}</strong> day streak</span>
      </div>
      <Calendar
        calendarType="gregory"
        locale="en-GB"
        next2Label={null}
        prev2Label={null}
        tileContent={({ date, view }) =>
          view === "month" && depositDays.has(dateKey(date)) ? (
            <span className="streak-mark" title="Savings contribution"><Flame aria-hidden="true" size={9} /></span>
          ) : view === "month" && activitiesByDay.has(dateKey(date)) ? (
            <span className="activity-dot" title={`${activitiesByDay.get(dateKey(date))?.length ?? 0} savings event(s)`} />
          ) : null
        }
      />
      <p className="calendar-note">
        <CalendarCheck2 aria-hidden="true" size={13} /> Flames mark contribution days. Dots show other on-chain activity.
      </p>
    </section>
  );
}
