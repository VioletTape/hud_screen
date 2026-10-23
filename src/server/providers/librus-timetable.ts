import { SchoolDay } from '../../shared/types.js';

type JsonRecord = Record<string, unknown>;
type Lesson = JsonRecord & { HourFrom: string; HourTo: string };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectLessons(value: unknown, result: Lesson[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectLessons(entry, result);
  } else if (isRecord(value)) {
    if (typeof value.HourFrom === 'string' && typeof value.HourTo === 'string') {
      if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(value.HourFrom) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(value.HourTo)) {
        throw new Error('Invalid lesson times');
      }
      result.push(value as Lesson);
    } else {
      for (const entry of Object.values(value)) collectLessons(entry, result);
    }
  }
}

export function summarizeWeek(weekStart: string, response: unknown): SchoolDay[] {
  let timetable = response;
  if (isRecord(timetable) && isRecord(timetable.Timetable)) timetable = timetable.Timetable;
  else if (isRecord(timetable) && isRecord(timetable.data) && isRecord(timetable.data.Timetable)) timetable = timetable.data.Timetable;
  if (!isRecord(timetable)) throw new Error('Invalid timetable response');

  const monday = new Date(`${weekStart}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday);
    day.setUTCDate(day.getUTCDate() + index);
    const date = day.toISOString().slice(0, 10);
    // A missing day is not evidence of a day off; never turn an incomplete response into "No lessons".
    if (!Object.hasOwn(timetable, date)) throw new Error('Incomplete timetable response');
    const lessons: Lesson[] = [];
    collectLessons(timetable[date], lessons);
    const active = lessons.filter(lesson => ![true, 1, 'true'].includes(lesson.IsCanceled as boolean | number | string))
      .sort((a, b) => a.HourFrom.localeCompare(b.HourFrom));
    if (!active.length) return { date };
    const first = active[0];
    const last = active.reduce((latest, lesson) => lesson.HourTo > latest.HourTo ? lesson : latest);
    return {
      date,
      firstLessonStart: first.HourFrom,
      firstLessonTitle: isRecord(first.Subject) && typeof first.Subject.Name === 'string' ? first.Subject.Name : 'Unknown subject',
      lastLessonEnd: last.HourTo,
    };
  });
}

export function timetableWeeks(now: Date): string[] {
  const weeks = new Set<string>();
  // Cover browser-local today/tomorrow across timezones, including a Sunday-to-Monday rollover.
  for (const offset of [-1, 0, 1, 2]) {
    const monday = new Date(now);
    monday.setUTCDate(monday.getUTCDate() + offset);
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    weeks.add(monday.toISOString().slice(0, 10));
  }
  return [...weeks];
}
