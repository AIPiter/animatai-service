export type ProjectMode   = 'lite' | 'deluxe' | 'standard'
export type ProjectStatus =
  | 'created' | 'scenes_ready' | 'generating' | 'done'
  | 'generating_videos' | 'videos_ready' | 'rendering' | 'rendered' | 'error'

export type SceneStatus      = 'pending' | 'generating' | 'done' | 'approved' | 'error'
export type VideoStatus      = 'pending' | 'queued' | 'generating' | 'done' | 'error'
export type StyleType        = 'anime' | 'cartoon' | 'pixar'

export interface Project {
  id:                    string
  name:                  string | null
  scenario:              string
  duration:              number
  scene_count:           number | null
  character_description: string | null
  status:                ProjectStatus
  style:                 StyleType
  mode:                  ProjectMode
  final_video_path:      string | null
  created_at:            string
  scenes?:               Scene[]
}

export interface Scene {
  id:               string
  project_id:       string
  scene_number:     number
  description:      string | null
  image_prompt:     string | null
  video_prompt:     string | null
  subtitle_text:    string | null
  image_path:       string | null
  video_path:       string | null
  last_frame_path:  string | null
  status:           SceneStatus
  video_status:     VideoStatus
  clip_duration:    number
  error_message:    string | null
  video_error:      string | null
}

export interface HistoryItem {
  id:         string
  scene_id:   string
  type:       'image' | 'video'
  path:       string
  created_at: string
}

// SSE events from the gateway
export type ProjectEvent =
  | { event: 'llm_done';       data: { scene_count: number; status: string } }
  | { event: 'image_done';     data: { scene_id: string; path: string } }
  | { event: 'image_error';    data: { scene_id: string; message: string } }
  | { event: 'video_done';     data: { scene_id: string; path: string } }
  | { event: 'video_error';    data: { scene_id: string; message: string } }
  | { event: 'all_videos_done'; data: Record<string, never> }
  | { event: 'render_done';    data: { path: string } }
  | { event: 'error';          data: { message: string } }
  | { event: 'pipeline_stage'; data: { stage: PipelineStage } }
  | { event: 'standard_frames_ready'; data: { frame_count: number } }

// Standard mode pipeline
export type PipelineStage =
  | 'parsing' | 'master_image' | 'visual_anchor' | 'frames'
  | 'frames_ready' | 'video_prompts' | 'clips' | 'concat'
  | 'complete' | 'failed'
