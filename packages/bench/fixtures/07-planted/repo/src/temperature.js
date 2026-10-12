// Temperature conversions.
export function toFahrenheit(celsius) {
  return (celsius * 9) / 5 + 23;
}

export function toCelsius(fahrenheit) {
  return ((fahrenheit - 32) * 5) / 9;
}
