/**
 * Alerting — spec §13. Single webhook, JSON body, fail-open (an alert
 * failure must never crash the job; it is logged to stderr instead).
 *
 * Severities: info | warning | critical.
 * Codes used by the job:
 *   file_missing     (warning, after 02:00 UTC when today's file absent)
 *   file_rejected    (warning)
 *   publish_overdue  (warning, after 06:00 UTC with a round still ingested)
 *   publish_failed   (critical)
 *   root_mismatch    (critical — DB root != on-chain root)
 *   invariant_failed (critical)
 *   reconcile_failed (critical)
 *   low_operator_sol (warning)
 */

export type Severity = 'info' | 'warning' | 'critical';

export interface Alert {
    severity: Severity;
    code: string;
    message: string;
    context?: Record<string, unknown>;
}

export class Alerter {
    constructor(private readonly webhookUrl: string | null) {}

    async send(alert: Alert): Promise<void> {
        const line = `[${alert.severity}] ${alert.code}: ${alert.message}`;
        if (alert.severity === 'critical') console.error(line, alert.context ?? '');
        else console.warn(line, alert.context ?? '');
        if (!this.webhookUrl) return;
        try {
            const res = await fetch(this.webhookUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    severity: alert.severity,
                    code: alert.code,
                    message: alert.message,
                    context: alert.context ?? {},
                    ts: new Date().toISOString(),
                }),
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) console.error(`alert webhook returned ${res.status}`);
        } catch (e) {
            console.error(`alert webhook failed: ${(e as Error).message}`);
        }
    }

    async info(code: string, message: string, context?: Record<string, unknown>): Promise<void> {
        return this.send({ severity: 'info', code, message, context });
    }
    async warning(code: string, message: string, context?: Record<string, unknown>): Promise<void> {
        return this.send({ severity: 'warning', code, message, context });
    }
    async critical(code: string, message: string, context?: Record<string, unknown>): Promise<void> {
        return this.send({ severity: 'critical', code, message, context });
    }
}

/** UTC-clock deadline checks for the scheduler (spec §13). */
export function utcNow(): { date: string; hour: number; minute: number } {
    const d = new Date();
    return {
        date: d.toISOString().slice(0, 10),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
    };
}

export function pastDeadline(hour: number, minute: number, deadlineHour: number): boolean {
    return hour > deadlineHour || (hour === deadlineHour && minute >= 0);
}
