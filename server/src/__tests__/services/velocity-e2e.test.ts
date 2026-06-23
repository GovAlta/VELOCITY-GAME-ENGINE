import { describe, it, expect, beforeAll } from 'vitest';
import { pool } from '../../config/database';
import * as velocityService from '../../services/velocity.service';

const MODULE_ID = 'd021f53b-961c-413f-b3f7-d42818d6c3ae';

// Reset module velocity to not_started before tests
beforeAll(async () => {
  await pool.query(
    `UPDATE module_velocity SET status = 'not_started', current_actor = NULL, loop_count = 0, turn_count = 0, started_at = NULL, completed_at = NULL, is_locked = false WHERE fk_mv_module = $1`,
    [MODULE_ID]
  );
  await pool.query(`DELETE FROM velocity_turn WHERE fk_turn_module = $1`, [MODULE_ID]);
  await pool.query(
    `UPDATE module_velocity_metrics SET velocity_score = 0, velocity_bonus = 0, velocity_penalty = 0, total_turns = 0, loopback_count = 0, alignment_count = 0, misalignment_count = 0 WHERE fk_mvm_module = $1`,
    [MODULE_ID]
  );
});

describe('Velocity E2E — Full Game Flow', () => {
  it('1. getModuleSteps returns 8 steps all not_started', async () => {
    const steps = await velocityService.getModuleSteps(MODULE_ID);
    expect(steps).toHaveLength(8);
    expect(steps[0].step_name).toBe('requirements');
    expect(steps.every(s => s.status === 'not_started')).toBe(true);
  });

  it('2. not_started -> ready_to_start', async () => {
    const { step, turn } = await velocityService.makeMove(MODULE_ID, 'requirements', {
      status: 'ready_to_start', actor: 'human', content: 'Starting requirements',
    });
    expect(step.status).toBe('ready_to_start');
    expect(turn.turn_action).toBe('start');
    expect(turn.turn_actor).toBe('human');
  });

  it('3. ready_to_start -> human_working', async () => {
    const { step } = await velocityService.makeMove(MODULE_ID, 'requirements', {
      status: 'human_working', actor: 'human', content: 'Writing requirements',
    });
    expect(step.status).toBe('human_working');
    expect(step.current_actor).toBe('human');
  });

  it('4. addNote without status change', async () => {
    const note = await velocityService.addNote(MODULE_ID, 'requirements', {
      content: 'Added auth user stories', actor: 'human',
    });
    expect(note.turn_action).toBe('note');
    expect(note.turn_content).toContain('auth user stories');
  });

  it('5. human_working -> ai_review (submit for review)', async () => {
    const { step, turn } = await velocityService.makeMove(MODULE_ID, 'requirements', {
      status: 'ai_review', actor: 'human', content: 'Ready for AI review',
      attachments: [{ filename: 'req.md', url: 'https://example.com' }],
    });
    expect(step.status).toBe('ai_review');
    expect(turn.turn_action).toBe('review');
  });

  it('6. ai_review -> human_working (REJECT — loop +1)', async () => {
    const { step, turn } = await velocityService.makeMove(MODULE_ID, 'requirements', {
      status: 'human_working', actor: 'ai', content: 'Missing edge cases',
    });
    expect(step.status).toBe('human_working');
    expect(step.loop_count).toBe(1);
    expect(turn.turn_action).toBe('reject');
  });

  it('7. human_working -> ai_review (resubmit)', async () => {
    const { step } = await velocityService.makeMove(MODULE_ID, 'requirements', {
      status: 'ai_review', actor: 'human', content: 'Added edge cases',
    });
    expect(step.status).toBe('ai_review');
  });

  it('8. ai_review -> completed (APPROVE)', async () => {
    const { step, turn } = await velocityService.makeMove(MODULE_ID, 'requirements', {
      status: 'completed', actor: 'ai', content: 'Requirements approved',
    });
    expect(step.status).toBe('completed');
    expect(turn.turn_action).toBe('approve');
  });

  it('9. planning auto-advanced after requirements completed', async () => {
    const steps = await velocityService.getModuleSteps(MODULE_ID);
    const planning = steps.find(s => s.step_name === 'planning');
    // Should be ready_to_start or working (ladder mechanic)
    expect(planning!.status).not.toBe('not_started');
  });

  it('10. turn history has correct count', async () => {
    const history = await velocityService.getStepTurns(MODULE_ID, 'requirements', 1, 50);
    // 6 moves + 1 note = 7 turns
    expect(history.data.length).toBe(7);
    expect(history.data.some(t => t.turn_action === 'reject')).toBe(true);
    expect(history.data.some(t => t.turn_action === 'approve')).toBe(true);
    expect(history.data.some(t => t.turn_action === 'note')).toBe(true);
  });

  it('11. lock step', async () => {
    const locked = await velocityService.setStepLock(MODULE_ID, 'requirements', true);
    expect(locked.is_locked).toBe(true);
  });

  it('12. invalid transition rejected', async () => {
    // architecture is still not_started, can only go to ready_to_start
    await expect(
      velocityService.makeMove(MODULE_ID, 'architecture', { status: 'ai_working', actor: 'ai' })
    ).rejects.toThrow('Invalid transition');
  });

  it('13. advance planning and complete it', async () => {
    const steps = await velocityService.getModuleSteps(MODULE_ID);
    const planning = steps.find(s => s.step_name === 'planning')!;

    // If auto-advanced to working, go to review. If ready_to_start, go to working first.
    if (planning.status === 'ready_to_start') {
      await velocityService.makeMove(MODULE_ID, 'planning', { status: 'human_working', actor: 'human', content: 'Planning' });
    }
    if (planning.status === 'ready_to_start' || planning.status === 'human_working' || planning.status === 'ai_working') {
      // Get current state
      const current = (await velocityService.getModuleSteps(MODULE_ID)).find(s => s.step_name === 'planning')!;
      if (current.status.includes('working')) {
        await velocityService.makeMove(MODULE_ID, 'planning', { status: 'human_review', actor: 'ai', content: 'Review' });
      }
    }
    const beforeApprove = (await velocityService.getModuleSteps(MODULE_ID)).find(s => s.step_name === 'planning')!;
    if (beforeApprove.status.includes('review')) {
      const { step } = await velocityService.makeMove(MODULE_ID, 'planning', { status: 'completed', actor: 'human', content: 'Approved' });
      expect(step.status).toBe('completed');
    }
  });

  it('14. send-back blocked by locked step', async () => {
    // Try to send back to requirements (which is locked)
    await expect(
      velocityService.sendBackToStep(MODULE_ID, 'requirements', { content: 'Send back' })
    ).rejects.toThrow('locked');
  });

  it('15. unlock and send-back works', async () => {
    await velocityService.setStepLock(MODULE_ID, 'requirements', false);
    // Now send back should work (if there's an active step after requirements)
    const steps = await velocityService.getModuleSteps(MODULE_ID);
    const hasActive = steps.some(s => s.status !== 'not_started' && s.status !== 'completed' && s.step_name !== 'requirements');
    if (hasActive) {
      await velocityService.sendBackToStep(MODULE_ID, 'requirements', { content: 'Found issue in planning' });
      const after = await velocityService.getModuleSteps(MODULE_ID);
      const req = after.find(s => s.step_name === 'requirements')!;
      expect(req.status).toBe('ready_to_start');
    }
  });

  it('16. metrics updated correctly', async () => {
    const dashboard = await velocityService.getDashboard();
    const metrics = dashboard.metrics.find(m => m.fk_mvm_module === MODULE_ID);
    expect(metrics).toBeDefined();
    expect(metrics!.velocity_score).not.toBe(0);
    expect(metrics!.total_turns).toBeGreaterThan(0);
    // Should have penalty from the rejection
    expect(metrics!.velocity_penalty).toBeGreaterThan(0);
  });

  it('17. getDashboard returns steps and metrics', async () => {
    const dashboard = await velocityService.getDashboard();
    expect(dashboard.steps.length).toBeGreaterThan(0);
    expect(dashboard.metrics.length).toBeGreaterThan(0);
    // Check step has expected fields
    const step = dashboard.steps[0];
    expect(step).toHaveProperty('step_name');
    expect(step).toHaveProperty('status');
    expect(step).toHaveProperty('module_name');
    expect(step).toHaveProperty('project_name');
  });

  it('18. getProjectVelocity returns grouped data', async () => {
    const projectId = (await pool.query('SELECT fk_module_project FROM module WHERE pk_module = $1', [MODULE_ID])).rows[0].fk_module_project;
    const data = await velocityService.getProjectVelocity(projectId);
    expect(data.modules.length).toBeGreaterThan(0);
    expect(data.modules[0].steps.length).toBe(8);
  });
});
