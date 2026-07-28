import { describe, expect, it } from 'vitest'
import {
  compileSchedule,
  defaultScheduleState,
  describeSchedule,
  describeScheduleState,
  parseSchedule,
} from './routineSchedule.js'

describe('routineSchedule', () => {
  it('compiles every builder frequency to conventional five-field cron', () => {
    const base = defaultScheduleState()
    expect(compileSchedule({ ...base, frequency: 'daily', time: '09:30' }).cron).toBe('30 9 * * *')
    expect(compileSchedule({ ...base, frequency: 'weekdays', time: '07:05' }).cron).toBe('5 7 * * 1-5')
    expect(compileSchedule({ ...base, frequency: 'weekly', time: '18:00', days: ['mon', 'wed', 'sun'] }).cron)
      .toBe('0 18 * * 1,3,0')
    expect(compileSchedule({ ...base, frequency: 'hourly', minute: 15 }).cron).toBe('15 * * * *')
    expect(compileSchedule({ ...base, frequency: 'interval', interval: 10 }).cron).toBe('*/10 * * * *')
    expect(compileSchedule({ ...base, frequency: 'cron', cron: '0 0 1 * * *' }).cron).toBe('0 0 1 * * *')
  })

  it('rejects incomplete builder states with a human message', () => {
    const base = defaultScheduleState()
    expect(compileSchedule({ ...base, frequency: 'weekly', days: [] }).error).toContain('at least one day')
    expect(compileSchedule({ ...base, frequency: 'daily', time: '' }).error).toContain('time of day')
    expect(compileSchedule({ ...base, frequency: 'interval', interval: 0 }).error).toContain('1–59')
    expect(compileSchedule({ ...base, frequency: 'cron', cron: '' }).error).toContain('cron expression')
    expect(compileSchedule({ ...base, frequency: 'cron', cron: 'sometimes maybe' }).error)
      .toContain('5, 6, or 7 fields')
  })

  it('round-trips its own output through parseSchedule', () => {
    const states = [
      { frequency: 'daily', time: '09:30' },
      { frequency: 'weekdays', time: '07:05' },
      { frequency: 'weekly', time: '18:00', days: ['tue', 'fri'] },
      { frequency: 'hourly', minute: 45 },
      { frequency: 'interval', interval: 5 },
    ]
    for (const partial of states) {
      const state = { ...defaultScheduleState(), ...partial }
      const { cron } = compileSchedule(state)
      const parsed = parseSchedule(cron)
      expect(parsed.frequency).toBe(state.frequency)
      if (state.time && ['daily', 'weekdays', 'weekly'].includes(state.frequency)) {
        expect(parsed.time).toBe(state.time)
      }
      if (state.frequency === 'weekly') expect(parsed.days).toEqual(state.days)
      if (state.frequency === 'hourly') expect(parsed.minute).toBe(state.minute)
      if (state.frequency === 'interval') expect(parsed.interval).toBe(state.interval)
    }
  })

  it('maps cron sunday 7 onto sunday and keeps days in Monday-first order', () => {
    expect(parseSchedule('0 9 * * 7,1')).toMatchObject({
      frequency: 'weekly',
      days: ['mon', 'sun'],
    })
  })

  it('falls back to raw cron mode for anything the builder cannot express', () => {
    for (const cron of ['0 0 9 * * Mon-Fri', '15 9 1 * *', '0 9 * 6 *', '*/90 * * * *', '9-17 * * * *']) {
      expect(parseSchedule(cron)).toMatchObject({ frequency: 'cron', cron })
    }
  })

  it('describes schedules as short human lines and empty schedules as Manual', () => {
    expect(describeSchedule('30 9 * * *')).toBe('Every day 09:30')
    expect(describeSchedule('5 7 * * 1-5')).toBe('Weekdays 07:05')
    expect(describeSchedule('0 18 * * 1,3')).toBe('Mon, Wed 18:00')
    expect(describeSchedule('15 * * * *')).toBe('Hourly at :15')
    expect(describeSchedule('*/10 * * * *')).toBe('Every 10 min')
    expect(describeSchedule('0 0 1 * * *')).toBe('0 0 1 * * *')
    expect(describeSchedule(null)).toBe('Manual')
    expect(describeSchedule('')).toBe('Manual')
  })

  it('describes builder state directly for the live form summary', () => {
    expect(describeScheduleState({ ...defaultScheduleState(), frequency: 'weekly', days: ['sat', 'sun'], time: '10:00' }))
      .toBe('Sat, Sun 10:00')
  })
})
