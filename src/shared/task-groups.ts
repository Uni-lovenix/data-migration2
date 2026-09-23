import type { MigrationTask, TaskTemplateMetadata } from './types'

export interface MigrationTaskGroup {
  key: string
  template?: TaskTemplateMetadata
  inferred?: boolean
  tasks: MigrationTask[]
}

export function groupTasksByTemplate(tasks: MigrationTask[]): MigrationTaskGroup[] {
  const groups: MigrationTaskGroup[] = []
  const templateGroups = new Map<string, MigrationTaskGroup>()
  const legacyTasks: MigrationTask[] = []

  for (const task of tasks) {
    if (!task.template) {
      legacyTasks.push(task)
      continue
    }
    const key = `template:${task.template.runId}`
    let group = templateGroups.get(key)
    if (!group) {
      group = {
        key,
        template: task.template,
        tasks: []
      }
      templateGroups.set(key, group)
      groups.push(group)
    }
    group.tasks.push(task)
  }

  const legacyGroups = groupLegacyDependencyChains(legacyTasks)
  groups.push(...legacyGroups)

  for (const group of groups) {
    if (group.template) {
      group.tasks.sort(
        (left, right) =>
          (left.template?.stepIndex ?? 0) - (right.template?.stepIndex ?? 0) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id)
      )
    }
  }

  groups.sort(
    (left, right) =>
      latestCreatedAt(right.tasks) - latestCreatedAt(left.tasks) ||
      left.key.localeCompare(right.key)
  )
  return groups
}

function latestCreatedAt(tasks: MigrationTask[]): number {
  return Math.max(...tasks.map((task) => Date.parse(task.createdAt)))
}

function groupLegacyDependencyChains(tasks: MigrationTask[]): MigrationTaskGroup[] {
  if (tasks.length === 0) {
    return []
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const parent = new Map(tasks.map((task) => [task.id, task.id]))

  const find = (id: string): string => {
    const current = parent.get(id) ?? id
    if (current === id) {
      return id
    }
    const root = find(current)
    parent.set(id, root)
    return root
  }

  const union = (left: string, right: string): void => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) {
      parent.set(rightRoot, leftRoot)
    }
  }

  for (const task of tasks) {
    for (const dependencyId of task.dependsOn ?? []) {
      if (taskById.has(dependencyId)) {
        union(task.id, dependencyId)
      }
    }
  }

  const components = new Map<string, MigrationTask[]>()
  for (const task of tasks) {
    const root = find(task.id)
    const component = components.get(root) ?? []
    component.push(task)
    components.set(root, component)
  }

  const emitted = new Set<string>()
  const groups: MigrationTaskGroup[] = []
  for (const task of tasks) {
    const root = find(task.id)
    if (emitted.has(root)) {
      continue
    }
    emitted.add(root)
    const component = components.get(root) ?? [task]
    if (component.length === 1) {
      groups.push({ key: `task:${task.id}`, tasks: [task] })
      continue
    }

    const ordered = orderLegacyDependencies(component, root)
    groups.push({
      key: `legacy:${root}`,
      inferred: true,
      template: {
        runId: `legacy:${root}`,
        templateId: 'legacy-dependency-group',
        templateName: '历史依赖任务组',
        stepIndex: 1,
        stepCount: ordered.length
      },
      tasks: ordered
    })
  }
  return groups
}

function orderLegacyDependencies(tasks: MigrationTask[], runId: string): MigrationTask[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const visited = new Set<string>()
  const ordered: MigrationTask[] = []

  const visit = (task: MigrationTask): void => {
    if (visited.has(task.id)) {
      return
    }
    visited.add(task.id)
    for (const dependencyId of task.dependsOn ?? []) {
      const dependency = taskById.get(dependencyId)
      if (dependency) {
        visit(dependency)
      }
    }
    ordered.push(task)
  }

  for (const task of tasks) {
    visit(task)
  }
  return ordered.map((task, index, all) => ({
    ...task,
    template: {
      runId: `legacy:${runId}`,
      templateId: 'legacy-dependency-group',
      templateName: '历史依赖任务组',
      stepIndex: index + 1,
      stepCount: all.length
    }
  }))
}
