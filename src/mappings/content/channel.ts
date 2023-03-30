import {
  Channel,
  ChannelFollow,
  Event,
  Membership,
  MetaprotocolTransactionResultFailed,
  MetaprotocolTransactionStatusEventData,
} from '../../model'
import { deserializeMetadata, genericEventFields, toAddress, u8aToBytes } from '../utils'
import {
  AppAction,
  ChannelMetadata,
  ChannelModeratorRemarked,
  ChannelOwnerRemarked,
  IChannelMetadata,
} from '@joystream/metadata-protobuf'
import { processChannelMetadata, processModeratorRemark, processOwnerRemark } from './metadata'
import { EventHandlerContext } from '../../utils/events'
import { processAppActionMetadata, deleteChannel, encodeAssets } from './utils'
import { Flat } from '../../utils/overlay'
import { DecodedMetadataObject } from '@joystream/metadata-protobuf/types'
import { generateAppActionCommitment } from '@joystream/js/utils'

export async function processChannelCreatedEvent({
  overlay,
  block,
  event: {
    asV1000: [
      channelId,
      { owner, dataObjects, channelStateBloatBond },
      channelCreationParameters,
      rewardAccount,
    ],
  },
}: EventHandlerContext<'Content.ChannelCreated'>) {
  const followsNum = await overlay
    .getEm()
    .getRepository(ChannelFollow)
    .countBy({ channelId: channelId.toString() })
  // create entity
  const channel = overlay.getRepository(Channel).new({
    id: channelId.toString(),
    isCensored: false,
    isExcluded: false,
    createdAt: new Date(block.timestamp),
    createdInBlock: block.height,
    ownerMemberId: owner.__kind === 'Member' ? owner.value.toString() : undefined,
    rewardAccount: toAddress(rewardAccount),
    channelStateBloatBond: channelStateBloatBond.amount,
    followsNum,
    videoViewsNum: 0,
    totalVideosCreated: 0,
  })

  const ownerMember = channel.ownerMemberId
    ? await overlay.getRepository(Membership).getByIdOrFail(channel.ownerMemberId)
    : undefined

  // deserialize & process metadata
  if (channelCreationParameters.meta !== undefined) {
    const appAction = deserializeMetadata(AppAction, channelCreationParameters.meta, {
      skipWarning: true,
    })

    if (appAction) {
      const channelMetadata = appAction.rawAction
        ? deserializeMetadata(ChannelMetadata, appAction.rawAction) ?? {}
        : {}
      const creatorType = channel.ownerMemberId
        ? AppAction.CreatorType.MEMBER
        : AppAction.CreatorType.CURATOR_GROUP
      const creatorId = channel.ownerMemberId ?? '' // curator groups not supported yet
      const expectedCommitment = generateAppActionCommitment(
        ownerMember?.totalChannelsCreated ?? -1,
        creatorId,
        AppAction.ActionType.CREATE_CHANNEL,
        creatorType,
        encodeAssets(channelCreationParameters.assets),
        appAction.rawAction ?? undefined,
        appAction.metadata ?? undefined
      )
      await processAppActionMetadata<Flat<Channel>>(
        overlay,
        channel,
        appAction,
        expectedCommitment,
        (entity) => processChannelMetadata(overlay, block, entity, channelMetadata, dataObjects)
      )
    } else {
      const metadata = deserializeMetadata(ChannelMetadata, channelCreationParameters.meta) ?? {}
      await processChannelMetadata(overlay, block, channel, metadata, dataObjects)
    }
  }

  if (ownerMember) {
    ownerMember.totalChannelsCreated += 1
  }
}

export async function processChannelUpdatedEvent({
  overlay,
  block,
  event: {
    asV1000: [, channelId, channelUpdateParameters, newDataObjects],
  },
}: EventHandlerContext<'Content.ChannelUpdated'>) {
  const channel = await overlay.getRepository(Channel).getByIdOrFail(channelId.toString())

  //  update metadata if it was changed
  if (channelUpdateParameters.newMeta) {
    const appAction = deserializeMetadata(AppAction, channelUpdateParameters.newMeta, {
      skipWarning: true,
    })

    let channelMetadataUpdate: DecodedMetadataObject<IChannelMetadata> | null | undefined
    if (appAction) {
      const channelMetadataBytes = u8aToBytes(appAction.rawAction)
      channelMetadataUpdate = deserializeMetadata(ChannelMetadata, channelMetadataBytes.toU8a(true))
    } else {
      channelMetadataUpdate = deserializeMetadata(ChannelMetadata, channelUpdateParameters.newMeta)
    }

    await processChannelMetadata(
      overlay,
      block,
      channel,
      channelMetadataUpdate ?? {},
      newDataObjects
    )
  }
}

export async function processChannelDeletedEvent({
  overlay,
  event: {
    asV1000: [, channelId],
  },
}: EventHandlerContext<'Content.ChannelDeleted'>): Promise<void> {
  await deleteChannel(overlay, channelId)
}

export async function processChannelDeletedByModeratorEvent({
  overlay,
  event: {
    asV1000: [, channelId],
  },
}: EventHandlerContext<'Content.ChannelDeletedByModerator'>): Promise<void> {
  await deleteChannel(overlay, channelId)
}

export async function processChannelVisibilitySetByModeratorEvent({
  overlay,
  event: {
    asV1000: [, channelId, isHidden],
  },
}: EventHandlerContext<'Content.ChannelVisibilitySetByModerator'>): Promise<void> {
  const channel = await overlay.getRepository(Channel).getByIdOrFail(channelId.toString())
  channel.isCensored = isHidden
}

export async function processChannelOwnerRemarkedEvent({
  block,
  indexInBlock,
  extrinsicHash,
  overlay,
  event: {
    asV1000: [channelId, messageBytes],
  },
}: EventHandlerContext<'Content.ChannelOwnerRemarked'>): Promise<void> {
  const channel = await overlay.getRepository(Channel).getByIdOrFail(channelId.toString())
  const decodedMessage = deserializeMetadata(ChannelOwnerRemarked, messageBytes)

  const result = decodedMessage
    ? await processOwnerRemark(overlay, block, indexInBlock, extrinsicHash, channel, decodedMessage)
    : new MetaprotocolTransactionResultFailed({
        errorMessage: 'Could not decode the metadata',
      })
  overlay.getRepository(Event).new({
    ...genericEventFields(overlay, block, indexInBlock, extrinsicHash),
    data: new MetaprotocolTransactionStatusEventData({
      result,
    }),
  })
}

export async function processChannelAgentRemarkedEvent({
  overlay,
  block,
  indexInBlock,
  extrinsicHash,
  event: {
    asV1000: [, channelId, messageBytes],
  },
}: EventHandlerContext<'Content.ChannelAgentRemarked'>): Promise<void> {
  const channel = await overlay.getRepository(Channel).getByIdOrFail(channelId.toString())
  const decodedMessage = deserializeMetadata(ChannelModeratorRemarked, messageBytes)

  const result = decodedMessage
    ? await processModeratorRemark(overlay, channel, decodedMessage)
    : new MetaprotocolTransactionResultFailed({
        errorMessage: 'Could not decode the metadata',
      })
  overlay.getRepository(Event).new({
    ...genericEventFields(overlay, block, indexInBlock, extrinsicHash),
    data: new MetaprotocolTransactionStatusEventData({
      result,
    }),
  })
}