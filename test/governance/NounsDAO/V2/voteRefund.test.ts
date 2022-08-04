import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import chai from 'chai';
import { solidity } from 'ethereum-waffle';
import { BigNumber, ContractReceipt } from 'ethers';
import { ethers } from 'hardhat';
import { NounsDAOLogicV2, NounsDescriptorV2__factory, NounsToken } from '../../../../typechain';
import { MaliciousVoter__factory } from '../../../../typechain/factories/contracts/test/MaliciousVoter__factory';
import {
  address,
  advanceBlocks,
  deployGovernorV2WithV2Proxy,
  deployNounsToken,
  encodeParameters,
  getSigners,
  populateDescriptorV2,
  TestSigners,
} from '../../../utils';

chai.use(solidity);
const { expect } = chai;

const REFUND_ERROR_MARGIN = ethers.utils.parseEther('0.0001');
const MAX_PRIORITY_FEE_CAP = ethers.utils.parseUnits('2', 'gwei');
const DEFAULT_GAS_OPTIONS = { maxPriorityFeePerGas: MAX_PRIORITY_FEE_CAP };

let deployer: SignerWithAddress;
let user: SignerWithAddress;
let user2: SignerWithAddress;
let signers: TestSigners;
let gov: NounsDAOLogicV2;
let token: NounsToken;
let snapshotId: number;

describe('Vote Refund', () => {
  before(async () => {
    signers = await getSigners();
    deployer = signers.deployer;
    user = signers.account0;
    user2 = signers.account1;

    token = await deployNounsToken(deployer);
    const descriptor = NounsDescriptorV2__factory.connect(await token.descriptor(), deployer);
    await populateDescriptorV2(descriptor);

    await token.connect(deployer).mint();
    await token.connect(deployer).transferFrom(deployer.address, user.address, 0);
    await token.connect(deployer).transferFrom(deployer.address, user.address, 1);

    await advanceBlocks(1);

    gov = await deployGovernorV2WithV2Proxy(deployer, token.address);
    await submitProposal(user);
  });

  beforeEach(async () => {
    snapshotId = await ethers.provider.send('evm_snapshot', []);
  });

  afterEach(async () => {
    await ethers.provider.send('evm_revert', [snapshotId]);
  });

  describe('withdraw', () => {
    it('reverts for non-owners [ @skip-on-coverage ]', async () => {
      await fundGov();
      await expect(gov.connect(user)._withdraw()).to.be.revertedWith('AdminOnly()');
    });

    it('sends balance to admin', async () => {
      await fundGov('123');
      const amount = ethers.utils.parseEther('123');

      const tx = await gov.connect(deployer)._withdraw();

      await expect(tx).to.changeEtherBalance(deployer, amount);
      await expect(tx).to.emit(gov, 'Withdraw').withArgs(amount, true);
    });
  });

  describe('castRefundableVote', () => {
    it('refunds users with votes', async () => {
      await fundGov();
      const balanceBefore = await user.getBalance();
      const tx = await gov.connect(user).castRefundableVote(1, 1, DEFAULT_GAS_OPTIONS);
      const r = await tx.wait();
      const balanceDiff = balanceBefore.sub(await user.getBalance());

      expect(r.gasUsed).to.be.gt(0);
      expect(balanceDiff).to.be.closeTo(BigNumber.from(0), REFUND_ERROR_MARGIN);
      expectRefundEvent(r, user, await txCostInEth(r));
      await expect(tx).to.emit(gov, 'VoteCast').withArgs(user.address, BigNumber.from(1), 1, 2, '');
    });

    it('does not refund users with no votes', async () => {
      await fundGov();
      const balanceBefore = await user2.getBalance();

      const tx = await gov.connect(user2).castRefundableVote(1, 1, DEFAULT_GAS_OPTIONS);
      const r = await tx.wait();

      expect(r.gasUsed).to.be.gt(0);
      const balanceDiff = balanceBefore.sub(await user2.getBalance());
      expect(balanceDiff).to.be.eq(await txCostInEth(r));
      await expect(tx).to.changeEtherBalance(gov, 0);
    });

    it('caps refund', async () => {
      await fundGov();
      const balanceBefore = await user.getBalance();

      const tx = await gov.connect(user).castRefundableVote(1, 1, {
        maxPriorityFeePerGas: ethers.utils.parseUnits('80', 'gwei'),
      });
      const r = await tx.wait();

      expect(r.gasUsed).to.be.gt(0);
      const balanceDiff = balanceBefore.sub(await user.getBalance());
      expect(balanceDiff).to.be.closeTo(await expectedCappedDiff(r), REFUND_ERROR_MARGIN);
    });

    it('does not refund when DAO balance is zero', async () => {
      expect(await ethers.provider.getBalance(gov.address)).to.eq(0);
      const balanceBefore = await user.getBalance();
      const tx = await gov.connect(user).castRefundableVote(1, 1, DEFAULT_GAS_OPTIONS);
      const r = await tx.wait();

      expect(r.gasUsed).to.be.gt(0);
      const balanceDiff = balanceBefore.sub(await user.getBalance());
      expect(balanceDiff).to.be.eq(await txCostInEth(r));
    });

    it('provides partial refund given insufficient balance', async () => {
      await fundGov('0.00001');
      const govBalance = ethers.utils.parseEther('0.00001');
      expect(await ethers.provider.getBalance(gov.address)).to.eq(govBalance);
      const balanceBefore = await user.getBalance();

      const tx = await gov.connect(user).castRefundableVote(1, 1, DEFAULT_GAS_OPTIONS);
      const r = await tx.wait();

      expect(r.gasUsed).to.be.gt(0);
      const expectedDiff = (await txCostInEth(r)).sub(govBalance);
      const balanceDiff = balanceBefore.sub(await user.getBalance());
      expect(balanceDiff).to.eq(expectedDiff);
    });

    it('malicious voter trying reentrance does not get refunded', async () => {
      const voter = await new MaliciousVoter__factory(deployer).deploy(gov.address, 2, 1, false);
      await token.connect(user).transferFrom(user.address, voter.address, 0);
      await token.connect(user).transferFrom(user.address, user2.address, 1);
      await advanceBlocks(1);
      await submitProposal(user2);
      const balanceBefore = await user.getBalance();

      const tx = await voter.connect(user).castVote(DEFAULT_GAS_OPTIONS);
      const r = await tx.wait();

      const balanceDiff = balanceBefore.sub(await user.getBalance());
      expect(balanceDiff).to.be.eq(await txCostInEth(r));
      await expect(tx).to.changeEtherBalance(gov, 0);
    });
  });

  describe('castRefundableVoteWithReason', () => {
    it('refunds users with votes', async () => {
      await fundGov();
      const balanceBefore = await user.getBalance();
      const tx = await gov
        .connect(user)
        .castRefundableVoteWithReason(1, 1, 'some reason', DEFAULT_GAS_OPTIONS);
      const r = await tx.wait();
      const balanceDiff = balanceBefore.sub(await user.getBalance());

      expect(r.gasUsed).to.be.gt(0);
      expect(balanceDiff).to.be.closeTo(BigNumber.from(0), REFUND_ERROR_MARGIN);

      expectRefundEvent(r, user, await txCostInEth(r));
      await expect(tx)
        .to.emit(gov, 'VoteCast')
        .withArgs(user.address, BigNumber.from(1), 1, 2, 'some reason');
    });

    it('does not refund users with no votes', async () => {
      await fundGov();
      const balanceBefore = await user2.getBalance();

      const tx = await gov
        .connect(user2)
        .castRefundableVoteWithReason(1, 1, 'some reason', DEFAULT_GAS_OPTIONS);
      const r = await tx.wait();

      expect(r.gasUsed).to.be.gt(0);
      const balanceDiff = balanceBefore.sub(await user2.getBalance());
      expect(balanceDiff).to.be.eq(await txCostInEth(r));
      await expect(tx).to.changeEtherBalance(gov, 0);
    });

    it('caps refund', async () => {
      await fundGov();
      const balanceBefore = await user.getBalance();

      const tx = await gov.connect(user).castRefundableVoteWithReason(1, 1, 'some reason', {
        maxPriorityFeePerGas: ethers.utils.parseUnits('80', 'gwei'),
      });
      const r = await tx.wait();

      expect(r.gasUsed).to.be.gt(0);
      const balanceDiff = balanceBefore.sub(await user.getBalance());
      expect(balanceDiff).to.be.closeTo(await expectedCappedDiff(r), REFUND_ERROR_MARGIN);
    });

    it('does not refund when DAO balance is zero', async () => {
      expect(await ethers.provider.getBalance(gov.address)).to.eq(0);
      const balanceBefore = await user.getBalance();
      const tx = await gov
        .connect(user)
        .castRefundableVoteWithReason(1, 1, 'some reason', DEFAULT_GAS_OPTIONS);
      const r = await tx.wait();

      expect(r.gasUsed).to.be.gt(0);
      const balanceDiff = balanceBefore.sub(await user.getBalance());
      expect(balanceDiff).to.be.eq(await txCostInEth(r));
    });

    it('provides partial refund given insufficient balance', async () => {
      await fundGov('0.00001');
      const govBalance = ethers.utils.parseEther('0.00001');
      expect(await ethers.provider.getBalance(gov.address)).to.eq(govBalance);
      const balanceBefore = await user.getBalance();

      const tx = await gov
        .connect(user)
        .castRefundableVoteWithReason(1, 1, 'some reason', DEFAULT_GAS_OPTIONS);
      const r = await tx.wait();

      expect(r.gasUsed).to.be.gt(0);
      const expectedDiff = (await txCostInEth(r)).sub(govBalance);
      const balanceDiff = balanceBefore.sub(await user.getBalance());
      expect(balanceDiff).to.eq(expectedDiff);
    });

    it('malicious voter trying reentrance does not get refunded', async () => {
      const voter = await new MaliciousVoter__factory(deployer).deploy(gov.address, 2, 1, true);
      await token.connect(user).transferFrom(user.address, voter.address, 0);
      await token.connect(user).transferFrom(user.address, user2.address, 1);
      await advanceBlocks(1);
      await submitProposal(user2);
      const balanceBefore = await user.getBalance();

      const tx = await voter.connect(user).castVote(DEFAULT_GAS_OPTIONS);
      const r = await tx.wait();

      const balanceDiff = balanceBefore.sub(await user.getBalance());
      expect(balanceDiff).to.be.eq(await txCostInEth(r));
      await expect(tx).to.changeEtherBalance(gov, 0);
    });
  });

  async function expectedCappedDiff(r: ContractReceipt): Promise<BigNumber> {
    const expectedRefund = await txCostInEth(r);
    const txGrossCost = r.gasUsed.mul(r.effectiveGasPrice);
    return txGrossCost.sub(expectedRefund);
  }

  async function txCostInEth(r: ContractReceipt): Promise<BigNumber> {
    return r.gasUsed.mul(await latestBasePlusMaxPriority());
  }

  async function latestBasePlusMaxPriority(): Promise<BigNumber> {
    const block = await ethers.provider.getBlock('latest');
    return block.baseFeePerGas!.add(MAX_PRIORITY_FEE_CAP);
  }

  async function fundGov(ethAmount: string = '100') {
    await deployer.sendTransaction({ to: gov.address, value: ethers.utils.parseEther(ethAmount) });
  }

  function expectRefundEvent(r: ContractReceipt, u: SignerWithAddress, expectedCost: BigNumber) {
    // Not using expect emit because it doesn't support the `closeTo` matcher
    const refundEvent = r.events!.find(e => e.event! === 'RefundableVote');
    expect(refundEvent).to.not.be.undefined;
    expect(refundEvent!.args!.voter).to.equal(u.address);
    expect(refundEvent!.args!.refundSent).to.be.true;
    expect(refundEvent!.args!.refundAmount).to.be.closeTo(expectedCost, REFUND_ERROR_MARGIN);
  }

  async function submitProposal(u: SignerWithAddress) {
    await gov
      .connect(u)
      .propose(
        [address(0)],
        ['0'],
        ['getBalanceOf(address)'],
        [encodeParameters(['address'], [address(0)])],
        '',
      );

    await advanceBlocks(2);
  }
});
