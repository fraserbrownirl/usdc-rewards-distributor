/**
 * Alerting — spec §8/§13. Every alert is one JSON line on stderr and, when
 * ALERT_WEBHOOK_URL is set, a POST of {"text": "<severity> <name>: <detail>"}.
 * Fail-open: a webhook failure is itself logged, never thrown.
 *
 * Alert names and severities come from the table in spec §13:
 *   file_missing (warning)   file_rejected (high)      funding_missing (high)
 *   operator_sol_low (warn)  publish_failed (high)     publish_overdue (high)
 *   invariant_failed (crit)  config_drift (crit)       root_mismatch (crit)
 *   tree_unavailable (crit)  solvency (crit)           overclaim (crit)
 *   shutdown (crit)
 * "high" is reported as severity "error".
 */

export type Severity = 'info' | 'warning' | 'error' | 'critical';

export interface Alert {
    severity: Severity;
    name: string;
    detail: string;
    context?: Record<string, unknown>;
}

export class Alerter {
    constructor(private readonly webhookUrl: string | null) {}

    async send(alert: Alert): Promise<void> {
        console.error(JSON.stringify({
            severity: alert.severity,
            name: alert.name,
            detail: alert.detail,
            ...(alert.context ? { context: alert.context } : {}),
            ts: new Date().toISOString(),
        }));
        if (!this.webhookUrl) return;
        try {
            const res = await fetch(this.webhookUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text: `${alert.severity} ${alert.name}: ${alert.detail}` }),
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) console.error(`alert webhook returned ${res.status}`);
        } catch (e) {
            console.error(`alert webhook failed: ${(e as Error).message}`);
        }
    }

    async info(name: string, detail: string, context?: Record<string, unknown>): Promise<void> {
        return this.send({ severity: 'info', name, detail, context });
    }
    async warning(name: string, detail: string, context?: Record<string, unknown>): Promise<void> {
        return this.send({ severity: 'warning', name, detail, context });
    }
    async error(name: string, detail: string, context?: Record<string, unknown>): Promise<void> {
        return this.send({ severity: 'error', name, detail, context });
    }
    async critical(name: string, detail: string, context?: Record<string, unknown>): Promise<void> {
        return this.send({ severity: 'critical', name, detail, context });
    }
}

/** UTC-clock helpers for the deadline checks (spec §8 step 12). */
export function utcToday(): string {
    return new Date().toISOString().slice(0, 10);
}

export function utcYesterday(): string {
    return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}

/** True once the UTC wall clock is at or past `hour`:00. */
export function pastUtcHour(hour: number): boolean {
    return new Date().getUTCHours() >= hour;
}
