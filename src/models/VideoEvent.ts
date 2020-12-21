import { getModelForClass, plugin, prop } from '@typegoose/typegoose'
import { AutoIncrementID } from '@typegoose/auto-increment'

const MAX_BUCKET_SIZE = 50000

export enum VideoEventType {
  AddView = 'ADD_VIEW',
}

export class VideoEvent {
  @prop({ required: true, index: true, unique: true })
  eventId: number

  @prop({ required: true, index: true })
  videoId: string

  @prop({ required: true, index: true })
  channelId: string

  @prop({ required: true })
  timestamp: Date

  @prop({ required: true, index: true, enum: VideoEventType })
  eventType: VideoEventType
}

export type UnsequencedVideoEvent = Omit<VideoEvent, 'eventId'>

@plugin(AutoIncrementID, { field: 'bucketId' })
class VideoEventsBucket {
  @prop({ required: true, index: true, unique: true })
  bucketId?: number

  @prop({ required: true, index: true })
  firstTimestamp: Date

  @prop({ required: true, index: true })
  lastTimestamp: Date

  @prop({ required: true })
  bucketSize: number

  @prop({ required: true, type: () => [VideoEvent] })
  events: VideoEvent[]
}

export const VideoEventsBucketModel = getModelForClass(VideoEventsBucket, {
  schemaOptions: { collection: 'videoEvents' },
})

export const insertVideoEventIntoBucket = async (unsequencedVideoEvent: UnsequencedVideoEvent) => {
  // TODO: possibly cache the last bucket
  const lastBucket = await VideoEventsBucketModel.findOne().sort({ bucketId: -1 })
  const lastEventId = lastBucket ? lastBucket.events[lastBucket.events.length - 1].eventId || 0 : 0
  const event: VideoEvent = {
    ...unsequencedVideoEvent,
    eventId: lastEventId + 1,
  }

  if (!lastBucket || lastBucket.bucketSize >= MAX_BUCKET_SIZE) {
    return await createNewBucketFromEvent(event)
  }

  lastBucket.events.push(event)
  lastBucket.bucketSize++
  lastBucket.lastTimestamp = event.timestamp
  await lastBucket.save()
}

const createNewBucketFromEvent = async (event: VideoEvent) => {
  const newBucket: VideoEventsBucket = {
    firstTimestamp: event.timestamp,
    lastTimestamp: event.timestamp,
    bucketSize: 1,
    events: [event],
  }

  await VideoEventsBucketModel.create(newBucket)
}
