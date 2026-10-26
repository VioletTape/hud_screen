import { IProvider } from './base.js';
import { ProviderResult } from '../../shared/types.js';

const LATITUDE = 51.1394;
const LONGITUDE = 16.9606;
const TIMEZONE = 'Europe/Warsaw';
const CACHE_TTL_MS = 15 * 60_000;

const WMO_LABELS: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Freezing drizzle',
  57: 'Heavy freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight showers',
  81: 'Moderate showers',
  82: 'Violent showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Heavy hailstorm',
};

const BFT_MAX_KMH = [1, 5, 11, 19, 28, 38, 49, 61, 74, 88, 102, 117];
const BFT_NAMES = [
  'Calm',
  'Light air',
  'Light breeze',
  'Gentle breeze',
  'Moderate breeze',
  'Fresh breeze',
  'Strong breeze',
  'High wind',
  'Gale',
  'Strong gale',
  'Storm',
  'Violent storm',
  'Hurricane force',
];

export function toBeaufort(kmh: number): { bft: number; label: string } {
  const idx = BFT_MAX_KMH.findIndex(max => kmh <= max);
  const bft = idx === -1 ? 12 : idx;
  return { bft, label: BFT_NAMES[bft] };
}

export function weatherIconName(code: number, isDay = true): string {
  if (code === 0) return isDay ? 'clear-day' : 'clear-night';
  if (code === 1 || code === 2) return isDay ? 'partly-cloudy-day' : 'partly-cloudy-night';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'thunderstorms-rain';
  return isDay ? 'partly-cloudy-day' : 'partly-cloudy-night';
}

export function analyzePressure(currentMsl: number, hourlyMsl: number[], startIdx = 0) {
  const hasHourly = startIdx >= 0 && startIdx < hourlyMsl.length;
  const p3 = hasHourly ? (hourlyMsl[Math.min(startIdx + 3, hourlyMsl.length - 1)] ?? currentMsl) : currentMsl;
  const p6 = hasHourly ? (hourlyMsl[Math.min(startIdx + 6, hourlyMsl.length - 1)] ?? currentMsl) : currentMsl;
  const delta3h = +(p3 - currentMsl).toFixed(1);
  const delta6h = +(p6 - currentMsl).toFixed(1);

  if (delta3h >= 3.0) {
    return {
      arrow: '↑↑',
      delta3h,
      delta6h,
      label: 'Rapidly rising',
      hint: 'Clearing fast, but expect gusty winds after a front. Biomet: may trigger vascular tension or headache.',
    };
  }
  if (delta3h <= -3.0) {
    return {
      arrow: '↓↓',
      delta3h,
      delta6h,
      label: 'Rapidly falling',
      hint: 'Front or storm approaching — rising wind and rain/storm risk. Biomet: fatigue, joint/headache sensitivity.',
    };
  }
  if (delta3h >= 1.0 || (delta3h >= 0 && delta6h >= 2.0)) {
    return {
      arrow: '↑',
      delta3h,
      delta6h,
      label: 'Rising',
      hint: 'High pressure building — drier air, clearing skies, lower rain risk.',
    };
  }
  if (delta3h <= -1.0 || (delta3h <= 0 && delta6h <= -2.0)) {
    return {
      arrow: '↓',
      delta3h,
      delta6h,
      label: 'Falling',
      hint: 'Low pressure moving in — clouds thickening, rain likely within 3–6h. Biomet: drowsiness, lower blood pressure.',
    };
  }
  return {
    arrow: '→',
    delta3h,
    delta6h,
    label: 'Steady',
    hint: 'Stable air mass — current weather conditions likely to persist.',
  };
}

function warsawIsoSlots(now = new Date()): { slot15: string; slotHour: string } {
  const formatted = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now).replace(' ', 'T');
  const dateHour = formatted.slice(0, 13);
  const min = Math.floor(parseInt(formatted.slice(14, 16), 10) / 15) * 15;
  return {
    slot15: `${dateHour}:${String(min).padStart(2, '0')}`,
    slotHour: `${dateHour}:00`,
  };
}

export class WeatherProvider implements IProvider {
  readonly name = 'weather';
  readonly displayName = 'Weather (Kozanów)';
  private cachedRaw: any = null;
  private cachedAt = 0;
  private inflight?: Promise<any>;

  isEnabled(): boolean {
    return true;
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    const result = await this.fetchData(true);
    return {
      success: result.status !== 'error',
      message: result.statusMessage || (result.status === 'error' ? 'Weather unavailable' : 'Connected'),
    };
  }

  async fetchData(force = false): Promise<ProviderResult> {
    const nowMs = Date.now();
    let staleWarning = false;

    if (force || !this.cachedRaw || nowMs - this.cachedAt >= CACHE_TTL_MS) {
      try {
        const raw = await (this.inflight ??= this.fetchOpenMeteo().finally(() => {
          this.inflight = undefined;
        }));
        if (!raw?.current) throw new Error('Invalid Open-Meteo response');
        this.cachedRaw = raw;
        this.cachedAt = Date.now();
      } catch (err) {
        if (!this.cachedRaw) {
          return {
            source: 'weather',
            displayName: 'Weather (Kozanów)',
            status: 'error',
            statusMessage: err instanceof Error ? err.message : 'Weather unavailable',
            lastUpdated: new Date().toISOString(),
            metrics: [],
            notifications: [],
          };
        }
        staleWarning = true;
      }
    }

    try {
      return this.buildResult(this.cachedRaw, staleWarning);
    } catch (err) {
      return {
        source: 'weather',
        displayName: 'Weather (Kozanów)',
        status: 'error',
        statusMessage: err instanceof Error ? err.message : 'Weather unavailable',
        lastUpdated: new Date().toISOString(),
        metrics: [],
        notifications: [],
      };
    }
  }

  private async fetchOpenMeteo(): Promise<any> {
    const params = new URLSearchParams({
      latitude: String(LATITUDE),
      longitude: String(LONGITUDE),
      timezone: TIMEZONE,
      current: [
        'temperature_2m',
        'apparent_temperature',
        'precipitation',
        'weather_code',
        'is_day',
        'wind_speed_10m',
        'wind_direction_10m',
        'wind_gusts_10m',
        'pressure_msl',
        'surface_pressure',
      ].join(','),
      minutely_15: [
        'temperature_2m',
        'apparent_temperature',
        'precipitation',
        'weather_code',
        'is_day',
        'lightning_potential',
        'cape',
        'wind_speed_10m',
        'wind_direction_10m',
        'wind_gusts_10m',
      ].join(','),
      hourly: [
        'temperature_2m',
        'apparent_temperature',
        'precipitation',
        'precipitation_probability',
        'weather_code',
        'is_day',
        'cape',
        'uv_index',
        'wind_speed_10m',
        'wind_direction_10m',
        'wind_gusts_10m',
        'pressure_msl',
      ].join(','),
      forecast_minutely_15: '48',
      forecast_hours: '12',
    });

    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    return res.json();
  }

  private buildResult(data: any, staleWarning: boolean): ProviderResult {
    const c = data.current;
    const m15 = data.minutely_15;
    const h = data.hourly;

    const { slot15, slotHour } = warsawIsoSlots();
    const m15Times: string[] = m15?.time || [];
    const hTimes: string[] = h?.time || [];

    const rawM15Start = m15Times.findIndex(t => t >= slot15);
    const m15Start = rawM15Start === -1 ? m15Times.length : rawM15Start;
    const rawHStart = hTimes.findIndex(t => t >= slotHour);
    const hStart = rawHStart === -1 ? hTimes.length : rawHStart;

    const hourlyProbByPrefix = new Map<string, number>();
    const hourlyUvByPrefix = new Map<string, number>();
    hTimes.forEach((t, i) => {
      const prefix = t.slice(0, 13);
      hourlyProbByPrefix.set(prefix, h.precipitation_probability?.[i] ?? 0);
      hourlyUvByPrefix.set(prefix, h.uv_index?.[i] ?? 0);
    });

    const dogWalk = Array.from({ length: Math.max(0, Math.min(6, m15Times.length - m15Start)) }, (_, offset) => {
      const i = m15Start + offset;
      const isoTime = m15Times[i];
      const code = m15.weather_code?.[i] ?? 0;
      const isDay = Boolean(m15.is_day?.[i] ?? 1);
      const windSpeed = m15.wind_speed_10m?.[i] ?? 0;
      const windGusts = m15.wind_gusts_10m?.[i] ?? 0;
      const wind = toBeaufort(windSpeed);
      const gust = toBeaufort(windGusts);
      const precip = m15.precipitation?.[i] ?? 0;
      const hourProb = hourlyProbByPrefix.get(isoTime.slice(0, 13)) ?? 0;
      const precipProb = precip > 0 ? Math.max(hourProb, 60) : hourProb;
      const lpi = m15.lightning_potential?.[i] ?? null;
      const cape = m15.cape?.[i] ?? 0;
      const hasStormClouds = precip > 0 || code >= 51;
      const lightning = code >= 95 || (lpi != null && lpi >= 1) || (cape >= 400 && hasStormClouds);

      return {
        time: isoTime.slice(11, 16),
        isoTime,
        temp: +(m15.temperature_2m?.[i] ?? 0).toFixed(1),
        feelsLike: +(m15.apparent_temperature?.[i] ?? 0).toFixed(1),
        precip: +precip.toFixed(1),
        precipProb: Math.round(precipProb),
        weatherCode: code,
        weatherLabel: WMO_LABELS[code] || `Code ${code}`,
        icon: code >= 95 || (lightning && hasStormClouds) ? 'thunderstorms-rain' : weatherIconName(code, isDay),
        isDay,
        windSpeed: +windSpeed.toFixed(1),
        windGusts: +windGusts.toFixed(1),
        windDir: m15.wind_direction_10m?.[i] ?? 0,
        windBft: wind.bft,
        windLabel: wind.label,
        gustBft: gust.bft,
        lightning,
        lpi,
        cape: Math.round(cape),
      };
    });

    const goOut = Array.from({ length: Math.max(0, Math.min(6, hTimes.length - hStart)) }, (_, offset) => {
      const i = hStart + offset;
      const isoTime = hTimes[i];
      const code = h.weather_code?.[i] ?? 0;
      const isDay = Boolean(h.is_day?.[i] ?? 1);
      const windSpeed = h.wind_speed_10m?.[i] ?? 0;
      const windGusts = h.wind_gusts_10m?.[i] ?? 0;
      const wind = toBeaufort(windSpeed);
      const gust = toBeaufort(windGusts);
      const precip = h.precipitation?.[i] ?? 0;
      const precipProb = h.precipitation_probability?.[i] ?? 0;
      const cape = h.cape?.[i] ?? 0;
      const hasStormClouds = precip > 0 || code >= 51;
      const lightning = code >= 95 || (cape >= 400 && hasStormClouds);

      return {
        time: isoTime.slice(11, 16),
        isoTime,
        temp: +(h.temperature_2m?.[i] ?? 0).toFixed(1),
        feelsLike: +(h.apparent_temperature?.[i] ?? 0).toFixed(1),
        precip: +precip.toFixed(1),
        precipProb: Math.round(precipProb),
        weatherCode: code,
        weatherLabel: WMO_LABELS[code] || `Code ${code}`,
        icon: code >= 95 || (lightning && hasStormClouds) ? 'thunderstorms-rain' : weatherIconName(code, isDay),
        isDay,
        windSpeed: +windSpeed.toFixed(1),
        windGusts: +windGusts.toFixed(1),
        windDir: h.wind_direction_10m?.[i] ?? 0,
        windBft: wind.bft,
        windLabel: wind.label,
        gustBft: gust.bft,
        lightning,
        lpi: null,
        cape: Math.round(cape),
      };
    });

    const slotAdvanced = Boolean(c.time && slot15 > c.time && dogWalk[0]);
    const activeSlot = slotAdvanced ? dogWalk[0] : null;
    const currentCode = activeSlot ? activeSlot.weatherCode : (c.weather_code ?? 0);
    const currentIsDay = activeSlot ? activeSlot.isDay : Boolean(c.is_day ?? 1);
    const currentWindSpeed = activeSlot ? activeSlot.windSpeed : (c.wind_speed_10m ?? 0);
    const currentWindGusts = activeSlot ? activeSlot.windGusts : (c.wind_gusts_10m ?? 0);
    const currentWind = toBeaufort(currentWindSpeed);
    const currentGust = toBeaufort(currentWindGusts);
    const currentHourPrefix = slotHour.slice(0, 13);
    const currentPrecip = activeSlot ? activeSlot.precip : (c.precipitation ?? 0);
    const currentHourProb = hourlyProbByPrefix.get(currentHourPrefix) ?? goOut[0]?.precipProb ?? 0;
    const currentPrecipProb = activeSlot
      ? activeSlot.precipProb
      : (currentPrecip > 0 ? Math.max(currentHourProb, 60) : currentHourProb);
    const currentUv = hourlyUvByPrefix.get(currentHourPrefix) ?? (hStart < hTimes.length ? h.uv_index?.[hStart] : undefined) ?? 0;
    const currentPressureMsl = slotAdvanced && hStart < hTimes.length
      ? (h.pressure_msl?.[hStart] ?? c.pressure_msl ?? 1013)
      : (c.pressure_msl ?? 1013);
    const pressureTrend = analyzePressure(currentPressureMsl, h.pressure_msl || [], hStart);
    const currentHasStormClouds = currentPrecip > 0 || currentCode >= 51;
    const currentLightning = activeSlot
      ? activeSlot.lightning
      : (currentCode >= 95 || Boolean(dogWalk[0]?.lightning && currentHasStormClouds));
    const currentLabel = WMO_LABELS[currentCode] || `Code ${currentCode}`;

    return {
      source: 'weather',
      displayName: 'Weather (Kozanów)',
      status: staleWarning ? 'warning' : 'healthy',
      statusMessage: staleWarning ? 'Refresh failed · showing cached forecast' : WMO_LABELS[currentCode] || 'Forecast active',
      lastUpdated: new Date(this.cachedAt || Date.now()).toISOString(),
      metrics: [],
      notifications: [],
      details: {
        location: 'Wrocław, Kozanów',
        current: {
          time: activeSlot ? activeSlot.time : (c.time || slot15).slice(11, 16),
          temp: activeSlot ? activeSlot.temp : +(c.temperature_2m ?? 0).toFixed(1),
          feelsLike: activeSlot ? activeSlot.feelsLike : +(c.apparent_temperature ?? 0).toFixed(1),
          precip: +currentPrecip.toFixed(1),
          precipProb: Math.round(currentPrecipProb),
          weatherCode: currentCode,
          weatherLabel: currentLabel,
          icon: activeSlot
            ? activeSlot.icon
            : (currentCode >= 95 || (currentLightning && currentHasStormClouds) ? 'thunderstorms-rain' : weatherIconName(currentCode, currentIsDay)),
          isDay: currentIsDay,
          uv: Math.round(currentUv),
          windSpeed: +currentWindSpeed.toFixed(1),
          windGusts: +currentWindGusts.toFixed(1),
          windDir: activeSlot ? activeSlot.windDir : (c.wind_direction_10m ?? 0),
          windBft: currentWind.bft,
          windLabel: currentWind.label,
          gustBft: currentGust.bft,
          pressureMsl: Math.round(currentPressureMsl),
          surfacePressure: Math.round(c.surface_pressure ?? 1000),
          pressureTrend,
          lightning: currentLightning,
        },
        dogWalk,
        goOut,
      },
    };
  }
}
