import type { Project, Scene } from '../types'
import { api, apiWithKeys } from './client'
import { useStore } from '../store/useStore'

function keys() {
  const { falKey, openrouterKey } = useStore.getState()
  return apiWithKeys(falKey, openrouterKey)
}

export async function listProjects(): Promise<Project[]> {
  return api('/api/projects')
}

export async function getProject(id: string): Promise<Project & { scenes: Scene[] }> {
  return api(`/api/projects/${id}`)
}

export async function createProject(data: {
  scenario:    string
  duration:    number
  style:       string
  mode:        string
  scene_count?: number
}): Promise<{ id: string }> {
  return api('/api/projects', {
    method:  'POST',
    body:    JSON.stringify(data),
    headers: keys(),
  })
}

export async function generateImages(projectId: string): Promise<void> {
  await api(`/api/projects/${projectId}/generate`, {
    method:  'POST',
    headers: keys(),
  })
}

export async function startVideoGeneration(projectId: string): Promise<void> {
  await api(`/api/projects/${projectId}/video`, {
    method:  'POST',
    headers: keys(),
  })
}

export async function renderProject(projectId: string): Promise<void> {
  await api(`/api/projects/${projectId}/render`, {
    method:  'POST',
    headers: keys(),
  })
}

export async function deleteProject(projectId: string): Promise<void> {
  await api(`/api/projects/${projectId}`, { method: 'DELETE' })
}

export async function updateScene(
  projectId: string,
  sceneId:   string,
  data:      { approved?: boolean; video_prompt?: string; image_prompt?: string },
): Promise<void> {
  await api(`/api/projects/${projectId}/scenes/${sceneId}`, {
    method: 'PATCH',
    body:   JSON.stringify(data),
  })
}

export async function regenerateSceneImage(projectId: string, sceneId: string): Promise<void> {
  await api(`/api/projects/${projectId}/scenes/${sceneId}/regenerate`, {
    method: 'POST',
    headers: keys(),
  })
}

export async function regenerateSceneVideo(projectId: string, sceneId: string): Promise<void> {
  await api(`/api/projects/${projectId}/scenes/${sceneId}/video`, {
    method: 'POST',
    headers: keys(),
  })
}
