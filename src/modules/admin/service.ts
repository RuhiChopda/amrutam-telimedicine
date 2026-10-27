import type { Db } from '../../shared/db';
import { notFound } from '../../shared/errors';
import type { AuditService } from '../audit/service';
import type { JobQueue } from '../jobs/queue';

export class AdminService {
  constructor(
    private readonly db: Db,
    private readonly queue: JobQueue,
    private readonly audit: AuditService,
  ) {}

  async deadJobs(limit = 50) {
    const rows = await this.queue.listDead(limit);
    // payloads contain identifiers only, never PHI
    return { items: rows };
  }

  async requeueJob(id: string) {
    if (!(await this.queue.requeueDead(id))) throw notFound('Dead job');
    await this.audit.recordStandalone({ action: 'admin.job_requeue', entityType: 'job', entityId: id });
  }

  async stats() {
    const { rows } = await this.db.query(`SELECT status, count(*)::int AS n FROM jobs GROUP BY status`);
    return { jobs: rows };
  }
}
