import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionReaper } from './reaper.js';

// ── Mocks ────────────────────────────────────────────────────────────────

function makeMockDb() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  };
}

function makeMockRedis() {
  return {
    del: vi.fn().mockResolvedValue(1),
  };
}

describe('SessionReaper', () => {
  let db: ReturnType<typeof makeMockDb>;
  let redis: ReturnType<typeof makeMockRedis>;
  let reaper: SessionReaper;

  beforeEach(() => {
    db = makeMockDb();
    redis = makeMockRedis();
    reaper = new SessionReaper(redis as any, db as any, 60_000);
  });

  afterEach(() => {
    reaper.stop();
  });

  // ── reap() ───────────────────────────────────────────────────────────

  describe('reap()', () => {
    it('returns 0 when no expired sessions are found', async () => {
      db.query.mockResolvedValue({ rows: [] });

      const count = await reaper.reap();

      expect(count).toBe(0);
      // Only the initial SELECT query
      expect(db.query).toHaveBeenCalledTimes(1);
      expect(db.query.mock.calls[0]![0]).toContain('SELECT');
    });

    it('archives messages and ends expired sessions', async () => {
      const expired = [
        { session_id: 'sess-1', workspace_id: 'ws-1', agent_id: 'agent-1' },
        { session_id: 'sess-2', workspace_id: 'ws-2', agent_id: 'agent-2' },
      ];

      // First call: SELECT expired sessions
      // Subsequent calls: archive + update for each session
      db.query
        .mockResolvedValueOnce({ rows: expired })  // SELECT
        .mockResolvedValue({ rows: [] });           // INSERT + UPDATE

      const count = await reaper.reap();

      expect(count).toBe(2);

      // For each session: 1 archive INSERT + 1 UPDATE = 2 db calls per session
      // Plus the initial SELECT = 1 + 2*2 = 5
      expect(db.query).toHaveBeenCalledTimes(5);

      // Verify archive INSERT was called for sess-1
      const archiveCall = db.query.mock.calls[1]!;
      expect(archiveCall[0]).toContain('INSERT INTO session_archives');
      expect(archiveCall[1]).toEqual(['sess-1', 'ws-1', 'agent-1']);

      // Verify UPDATE was called for sess-1
      const updateCall = db.query.mock.calls[2]!;
      expect(updateCall[0]).toContain("UPDATE sessions SET status = 'ended'");
      expect(updateCall[1]).toEqual(['sess-1']);
    });

    it('cleans up Redis keys for each expired session', async () => {
      const expired = [
        { session_id: 'sess-abc', workspace_id: 'ws-1', agent_id: 'agent-1' },
      ];

      db.query
        .mockResolvedValueOnce({ rows: expired })
        .mockResolvedValue({ rows: [] });

      await reaper.reap();

      expect(redis.del).toHaveBeenCalledWith(
        'session:sess-abc:context',
        'honorclaw:session:sess-abc:state',
      );
    });

    it('continues processing if one session fails and counts only successes', async () => {
      const expired = [
        { session_id: 'sess-ok', workspace_id: 'ws-1', agent_id: 'a1' },
        { session_id: 'sess-fail', workspace_id: 'ws-2', agent_id: 'a2' },
        { session_id: 'sess-ok2', workspace_id: 'ws-3', agent_id: 'a3' },
      ];

      db.query
        .mockResolvedValueOnce({ rows: expired })       // SELECT
        .mockResolvedValueOnce({ rows: [] })             // sess-ok archive
        .mockResolvedValueOnce({ rows: [] })             // sess-ok update
        .mockRejectedValueOnce(new Error('DB error'))    // sess-fail archive throws
        .mockResolvedValueOnce({ rows: [] })             // sess-ok2 archive
        .mockResolvedValueOnce({ rows: [] })             // sess-ok2 update
        .mockResolvedValue({ rows: [] });

      const count = await reaper.reap();

      // Only 2 out of 3 succeeded
      expect(count).toBe(2);
    });
  });

  // ── start() / stop() ────────────────────────────────────────────────

  describe('start() / stop()', () => {
    it('starts an interval timer and stop clears it', () => {
      vi.useFakeTimers();

      const reapSpy = vi.spyOn(reaper, 'reap').mockResolvedValue(0);

      reaper.start();

      // Advance past one interval
      vi.advanceTimersByTime(60_000);
      expect(reapSpy).toHaveBeenCalledTimes(1);

      // Advance past another interval
      vi.advanceTimersByTime(60_000);
      expect(reapSpy).toHaveBeenCalledTimes(2);

      reaper.stop();

      // After stop, no more calls
      vi.advanceTimersByTime(60_000);
      expect(reapSpy).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('stop() is safe to call when not started', () => {
      expect(() => reaper.stop()).not.toThrow();
    });
  });
});
