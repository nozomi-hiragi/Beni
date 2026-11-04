import { taskDocuments } from '../documents';
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validProjectId, validTaskId } from '../../shared/ids';
import { directory, metadata, newMetadata, projectRoot, recoverTasks, pathExists, writeJson, type TaskMetadata } from '../data';
export type Project = {
  id: string;
  name: string;
  folder: string;
};
export type TaskRow = {
  id: string;
  project_id: string;
  name: string;
  phase: string;
  status: string;
};
export class Store {
  private readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, {
      create: true
    });
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks','messages','documents')").all();
    const columns = this.db.query('PRAGMA table_info(projects)').all() as {
      name: string;
      type: string;
    }[];
    if (tables.length || columns.some(c => c.name === 'id' && c.type.toUpperCase() !== 'TEXT')) {
      this.db.close();
      throw Error('Legacy data detected. Stop Beni and run bun run migrate:data -- <data-directory> before restarting.');
    }
    this.db.exec('CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,folder TEXT NOT NULL UNIQUE)');
  }
  close() {
    this.db.close();
  }
  projects(): Project[] {
    const rows = this.db.query('SELECT * FROM projects ORDER BY id DESC').all() as Project[];
    for (const row of rows) {
      if (!existsSync(row.folder)) continue;
      const data = metadata(join(projectRoot(row.folder), 'project.json'), 'project');
      if (data.id !== row.id) throw Error('Project ID mismatch');
      row.name = data.name;
      this.db.query('UPDATE projects SET name=? WHERE id=?').run(row.name, row.id);
      recoverTasks(row.folder);
    }
    return rows;
  }
  createProject(name: string, folder: string): Project {
    if (typeof name !== 'string' || !name.trim()) throw Error('Empty value');
    const normalized = resolve(folder),
      root = projectRoot(normalized),
      file = join(root, 'project.json');
    const data = pathExists(file) ? metadata(file, 'project') : newMetadata('project', name.trim());
    const old = this.db.query('SELECT * FROM projects WHERE id=?').get(data.id) as Project | null;
    if (old && old.folder !== normalized && existsSync(old.folder)) throw Error('Duplicate live project copy. Use bun run clone:project to create a separate project.');
    if (!pathExists(file)) writeJson(file, data);
    recoverTasks(normalized);
    this.db.query('INSERT INTO projects(id,name,folder) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,folder=excluded.folder').run(data.id, data.name, normalized);
    return {
      id: data.id,
      name: data.name,
      folder: normalized
    };
  }
  tasks(projectId?: string): TaskRow[] {
    if (projectId !== undefined && !validProjectId(projectId)) throw Error('Invalid project');
    const projects = this.projects().filter(p => projectId === undefined || p.id === projectId);
    return projects.flatMap(project => {
      if (!existsSync(project.folder)) return [];
      const root = recoverTasks(project.folder);
      return readdirSync(root).filter(validTaskId).map(id => {
        const value = metadata(join(root, id, 'task.json'), 'task') as TaskMetadata;
        return {
          id: value.id,
          project_id: project.id,
          name: value.name,
          phase: value.phase,
          status: value.status
        };
      });
    }).sort((a, b) => b.id.localeCompare(a.id));
  }
  task(id: string): TaskRow | null {
    if (!validTaskId(id)) throw Error('Invalid task');
    const matches = this.tasks().filter(task => task.id === id);
    if (matches.length > 1) throw Error('Duplicate task ID');
    return matches[0] ?? null;
  }
  createTask(projectId: string, name: string, initialize?: (task: TaskRow) => void): TaskRow {
    if (!validProjectId(projectId)) throw Error('Invalid project');
    if (typeof name !== 'string' || !name.trim()) throw Error('Empty value');
    const project = this.projects().find(p => p.id === projectId);
    if (!project) throw Error('Unknown project');
    const value = {
      ...newMetadata('task', name.trim()),
      phase: 'requirements',
      status: 'idle'
    };
    const task = {
      id: value.id,
      project_id: projectId,
      name: value.name,
      phase: value.phase,
      status: value.status
    };
    const root = directory(join(projectRoot(project.folder), 'tasks')),
      path = join(root, value.id);
    if (existsSync(path)) throw Error('Task ID collision');
    try {
      if (initialize) initialize(task);else taskDocuments(project.folder, task.id, {
        requirements: `# ${task.name}\n`
      }, true);
      directory(path);
      writeJson(join(path, 'task.json'), value);
    } catch (error) {
      if (existsSync(path)) rmSync(path, {
        recursive: true
      });
      throw error;
    }
    return task;
  }
}
