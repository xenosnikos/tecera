// Calendar helpers.
export function isLeapYear(year) {
  return year % 4 === 0;
}

export function daysInMonth(year, month) {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
