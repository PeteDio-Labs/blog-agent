/**
 * Mission Control Backend Client
 * Fetches cluster state for the Context Agent.
 */

import { logger } from '../utils/logger.js';
import type { ArgoApp, ClusterHealth } from '../types.js';

const log = logger.child('mc-backend-client');

export class MCBackendClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async getArgoApps(): Promise<ArgoApp[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/argocd/applications`);
      if (!res.ok) {
        log.warn(`ArgoCD apps fetch failed (${res.status})`);
        return [];
      }
      const data = await res.json() as { applications: ArgoApp[] };
      return data.applications ?? [];
    } catch (err) {
      log.error('Failed to fetch ArgoCD apps', err);
      return [];
    }
  }

  async getClusterHealth(): Promise<ClusterHealth> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/kubernetes/cluster/status`);
      if (!res.ok) {
        log.warn(`Cluster health fetch failed (${res.status})`);
        return { nodes: 0, podsRunning: 0, podsNotReady: 0 };
      }
      return res.json() as Promise<ClusterHealth>;
    } catch (err) {
      log.error('Failed to fetch cluster health', err);
      return { nodes: 0, podsRunning: 0, podsNotReady: 0 };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
