const IERC20 = artifacts.require("IERC20");
const ERC20Mintable = artifacts.require("MockERC20Mintable");
const GoodGhosting = artifacts.require("GoodGhosting");
const LendingPoolAddressesProviderMock = artifacts.require("LendingPoolAddressesProviderMock");
const {web3tx, toWad} = require("@decentral.ee/web3-test-helpers");
const timeMachine = require("ganache-time-traveler");
const truffleAssert = require("truffle-assertions");

contract("GoodGhosting", (accounts) => {
    const BN = web3.utils.BN; // https://web3js.readthedocs.io/en/v1.2.7/web3-utils.html#bn
    const admin = accounts[0];
    let token;
    let aToken;
    let bank;
    let pap;
    let player1 = accounts[1];
    let player2 = accounts[2];
    const weekInSecs = 180;
    const daiDecimals = web3.utils.toBN(1000000000000000000);
    const segmentPayment = daiDecimals.mul(new BN(10)); // equivalent to 10 DAI
    const segmentCount = 6;
    const segmentLength = 180;

    beforeEach(async () => {
        global.web3 = web3;
        token = await web3tx(ERC20Mintable.new, "ERC20Mintable.new")("MINT", "MINT", {from: admin});
        // creates dai for player1 to hold.
        // Note DAI contract returns value to 18 Decimals
        // so token.balanceOf(address) should be converted with BN
        // and then divided by 10 ** 18
        await web3tx(token.mint, "token.mint 100 -> player1")(player1, toWad(1000), {from: admin});
        pap = await web3tx(LendingPoolAddressesProviderMock.new, "LendingPoolAddressesProviderMock.new")("TOKEN_NAME", "TOKEN_SYMBOL", {from: admin});
        aToken = await IERC20.at(await pap.getLendingPool.call());
        await pap.setUnderlyingAssetAddress(token.address);
        bank = await web3tx(GoodGhosting.new, "GoodGhosting.new")(
            token.address,
            aToken.address,
            pap.address,
            segmentCount,
            segmentLength,
            segmentPayment,
            {from: admin},
        );
    });

    async function approveDaiToContract(fromAddr) {
        await web3tx(token.approve, "token.approve to send tokens to contract")(bank.address, segmentPayment, {from: fromAddr});
    }

    describe("pre-flight checks", async() => {
        it("checks if DAI and aDAI contracts have distinct addresses", async () => {
            const daiAdd = token.address;
            const aDaiAdd = pap.address;
            assert(daiAdd !== aDaiAdd, `DAI ${daiAdd} and ADAI ${aDaiAdd} shouldn't be the same address`);
        });

        it("checks that contract starts holding 0 Dai and 0 aDai", async () => {
            const daiBalance = await token.balanceOf(bank.address);
            const aDaiBalance = await pap.balanceOf(bank.address);
            assert(
                daiBalance.toNumber() === 0,
                `On start, smart contract's DAI balance should be 0 DAI - got ${daiBalance.toNumber()} DAI`,
            );
            assert(
                aDaiBalance.toNumber() === 0,
                `on start, smart contract's aDAI balance should be 0 aDAI - got ${aDaiBalance.toNumber()} aDAI`,
            );
        });

        it("checks if player1 received minted DAI tokens", async () => {
            const usersDaiBalance = await token.balanceOf(player1);
            // BN.gte => greater than or equals (see https://github.com/indutny/bn.js/)
            assert(usersDaiBalance.div(daiDecimals).gte(new BN(1000)), `Player1 balance should be greater than or equal to 100 DAI at start - current balance: ${usersDaiBalance}`);
        });

        it("checks that contract's variables were properly initialized", async () => {
            const inboundCurrencyResult = await bank.daiToken.call();
            const interestCurrencyResult = await bank.adaiToken.call();
            const lendingPoolAddressProviderResult = await bank.lendingPoolAddressProvider.call();
            const lastSegmentResult = await bank.lastSegment.call();
            const segmentLengthResult = await bank.segmentLength.call();
            const segmentPaymentResult = await bank.segmentPayment.call();
            assert(inboundCurrencyResult === token.address, `Inbound currency doesn't match. expected ${token.address}; got ${inboundCurrencyResult}`);
            assert(interestCurrencyResult === aToken.address, `Interest currency doesn't match. expected ${aToken.address}; got ${interestCurrencyResult}`);
            assert(lendingPoolAddressProviderResult === pap.address, `LendingPoolAddressesProvider doesn't match. expected ${pap.address}; got ${lendingPoolAddressProviderResult}`);
            assert(new BN(lastSegmentResult).eq(new BN(segmentCount)), `LastSegment info doesn't match. expected ${segmentCount}; got ${lastSegmentResult}`);
            assert(new BN(segmentLengthResult).eq(new BN(segmentLength)), `SegmentLength doesn't match. expected ${segmentLength}; got ${segmentLengthResult}`);
            assert(new BN(segmentPaymentResult).eq(new BN(segmentPayment)), `SegmentPayment doesn't match. expected ${segmentPayment}; got ${segmentPaymentResult}`);
        });
    });

    describe("segments tracking checks", async() => {
        it("starts game at segment zero", async () => {
            const expectedSegment = new BN(0);
            const result = await bank.getCurrentSegment.call({from: admin});
            assert(
                result.eq(new BN(0)),
                `should start at segment ${expectedSegment} but started at ${result.toNumber()} instead.`,
            );
        });

        it("keeps correct track of segments along the game", async () => {
            let result = -1;
            for (let expectedSegment = 0; expectedSegment < segmentCount; expectedSegment++) {
                result = await bank.getCurrentSegment.call({from: admin});
                assert(
                    result.eq(new BN(expectedSegment)),
                    `expected segment ${expectedSegment} actual ${result.toNumber()}`,
                );
                await timeMachine.advanceTimeAndBlock(weekInSecs);
            }
        });
    });

    describe("joinGame checks", async() => {
        it("reverts when user tries to join after the first segment", async () => {
            await timeMachine.advanceTime(weekInSecs);
            approveDaiToContract(player1);
            truffleAssert.reverts(bank.joinGame({from: player1}), "game has already started");
        });

        it("reverts when user tries to join the game twice", async () => {
            approveDaiToContract(player1);
            await web3tx(bank.joinGame, "join game")({from: player1});
            approveDaiToContract(player1);
            truffleAssert.reverts(bank.joinGame({from: player1}), "The player should not have joined the game before");
        });

        it("stores the players who joined the game", async ()=>{
            // Player1 joins the game
            approveDaiToContract(player1);
            await web3tx(bank.joinGame,"join the game")({ from: player1 });
            // Mints DAI for player2 (not minted in the beforeEach hook) and joins the game
            await web3tx(token.mint, "token.mint 100 -> player2")(player2, toWad(1000), {from: admin});
            approveDaiToContract(player2);
            await web3tx(bank.joinGame,"join the game")({ from: player2 });

            // Reads stored players and compares against player1 and player2
            // Remember: "iterablePlayers" is an array, so we need to pass the index we want to retrieve.
            const storedPlayer1 = await bank.iterablePlayers.call(0);
            const storedPlayer2 = await bank.iterablePlayers.call(1);
            assert(storedPlayer1 === player1);
            assert(storedPlayer2 === player2);
        });

        it("emits event JoinedGame", async () => {
            approveDaiToContract(player1);
            const result = await web3tx(bank.joinGame, "join game")({from: player1});
            let playerEvent = "";
            let paymentEvent = 0;
            truffleAssert.eventEmitted(
                result,
                "JoinedGame",
                (ev) => {
                    playerEvent = ev.player;
                    paymentEvent = ev.amount;
                    return playerEvent === player1 && new BN(paymentEvent).eq(new BN(segmentPayment));
                },
                `JoinedGame event should be emitted when an user joins the game with params\n
                player: expected ${player1}; got ${playerEvent}\n
                paymentAmount: expected ${segmentPayment}; got ${paymentEvent}`,
            );
        });

    });


    // 🤝 intergration test
    // 🚨 Finish this test so its working with BN.js
    // it("users can deposit first segment when they join", async () => {
    //     approveDaiToContract(player1);

    //     await web3tx(bank.joinGame, "join game")({ from: player1 });

    //     // await timeMachine.advanceTimeAndBlock(weekInSecs + 1);

    //     // await web3tx(
    //     //     bank.makeDeposit,
    //     //     "token.approve to send tokens to contract"
    //     // )({
    //     //     from: player1,
    //     // });

    //     const contractsDaiBalance = await token.balanceOf(bank.address);
    //     const contractsADaiBalance = await aToken.balanceOf(bank.address);
    //     const player = await bank.players(player1);
    //     console.log(
    //         "console.log",
    //         contractsADaiBalance,
    //         contractsDaiBalance,
    //         player.amountPaid.toString()
    //     );
    //     assert(contractsDaiBalance.eq(web3.utils.toBN(0)), "Contract DAI Balance should be 0")
    //     // here we should expect to see that the user has paid in 10 aDAI to the Good Ghosting
    //     // smart contract.
    //     // I think the smart contrat is correct, but i need to test this correctly with BN.js
    //     // assert(contractsADaiBalance.eq(expectedAmount), `expected: ${expectedAmount}  actual: ${contractsADaiBalance}`)
    //     // assert(contractsDaiBalance.eq(web3.utils.toBN(0)), `expected: ${expectedAmount}  actual: ${contractsADaiBalance}`)

    // });

    it("users can deposit after first segment", async () => {
        approveDaiToContract(player1);
        await web3tx(bank.joinGame, "join game")({from: player1});

        await timeMachine.advanceTimeAndBlock(weekInSecs);

        approveDaiToContract(player1);

        const result = await web3tx(bank.makeDeposit, "depositing in 2nd segment")({from: player1});
        truffleAssert.eventEmitted(result, "Deposit", (ev) => {
            return ev.player === player1;
        }, "player was not able to deposit after first segment");
    });

    it("unregistered players cannot deposit", async () => {
        approveDaiToContract(player2);
        truffleAssert.reverts(bank.makeDeposit({from: player2}), "not registered");
    });

    it("users cannot play if they missed payment fo the previous segment", async () => {
        approveDaiToContract(player1);
        await web3tx(bank.joinGame, "join game")({from: player1});
        const overTwoWeeks = weekInSecs * 2;
        await timeMachine.advanceTime(overTwoWeeks);
        await approveDaiToContract(player1);
        truffleAssert.reverts(bank.makeDeposit({from: player1}), "previous segment was not paid - out of game");
    });


    it("redeems amount after all segments are over", async () => { // having test with only 1 player for now
        approveDaiToContract(player1);
        await web3tx(bank.joinGame, "join game")({from: player1});
        await timeMachine.advanceTime(weekInSecs);
        approveDaiToContract(player1);

        await web3tx(bank.makeDeposit, "make a deposit")({from: player1});
        const result = await web3tx(bank.redeemFromExternalPool, "redeem funds")({from: admin});
        const contractsDaiBalance = await token.balanceOf(bank.address);
        truffleAssert.eventEmitted(result, "FundsRedeemedFromExternalPool", (ev) => {
            return ev.totalAmount === contractsDaiBalance;
        }, "unable to redeem");
    });

    it("unable to redeem before game ends", async () => { // having test with only 1 player for now
        approveDaiToContract(player1);
        await web3tx(bank.joinGame, "join game")({from: player1});
        truffleAssert.reverts(bank.redeemFromExternalPool({from: player1}), "Game is not completed");
    })

    it("allocate withdraw amounts", async () => { // having test with only 1 player for now
        approveDaiToContract(player1);
        await web3tx(bank.joinGame, "join game")({from: player1});
        await timeMachine.advanceTime(weekInSecs);
        approveDaiToContract(player1);
        await web3tx(bank.makeDeposit, "make a deposit")({from: player1});
        await web3tx(bank.redeemFromExternalPool, "redeem funds")({from: admin});
        await web3tx(bank.allocateWithdrawAmounts, "allocate withdraw amount")({from: admin});

        truffleAssert.eventEmitted(result, "WinnersAnnouncement", (ev) => {
            return ev.winners === [player1];
        }, "unable to allocate withdraw amounts")

    })

    it("unable to allocate withdraw amounts", async () => { // having test with only 1 player for now
        approveDaiToContract(player1);
        await web3tx(bank.joinGame, "join game")({from: player1});
        await timeMachine.advanceTime(weekInSecs);
        approveDaiToContract(player1);
        await web3tx(bank.makeDeposit, "make a deposit")({from: player1});
        truffleAssert.reverts(bank.allocateWithdrawAmounts({from: player1}), "Funds not redeemed from external pool yet");
    })

    it("user is able to withdraw amount", async () => { // having test with only 1 player for now
        approveDaiToContract(player1);
        await web3tx(bank.joinGame, "join game")({from: player1});
        await timeMachine.advanceTime(weekInSecs);
        approveDaiToContract(player1);
        await web3tx(bank.makeDeposit, "make a deposit")({from: player1});
        await web3tx(bank.redeemFromExternalPool, "redeem funds")({from: admin});
        await web3tx(bank.allocateWithdrawAmounts, "allocate withdraw amount")({from: admin});
        await web3tx(bank.withdraw, "withdraw funds")({from: player1});

        truffleAssert.eventEmitted(result, "Withdrawal", (ev) => {
            return ev.player === player1;
        }, "unable to withdraw amount")

    })

    it("user unable to withdraw amount", async () => { // having test with only 1 player for now
        approveDaiToContract(player1);
        await web3tx(bank.joinGame, "join game")({from: player1});
        await timeMachine.advanceTime(weekInSecs);
        approveDaiToContract(player1);
        await web3tx(bank.makeDeposit, "make a deposit")({from: player1});
        await web3tx(bank.redeemFromExternalPool, "redeem funds")({from: admin});
        truffleAssert.reverts(bank.withdraw({from: player1}), "no balance available for withdrawal");

    })

    describe("reverts when contract is paused", () => {
        beforeEach(async function () {
            await bank.pause({from: admin});
        });

        it("pauses the contract", async () => {
            const result = await bank.paused.call({from: admin});
            assert(result, "contract is not paused");
        });

        it("unpauses the contract", async () => {
            await bank.unpause({from: admin});
            const result = await bank.pause.call({from: admin});
            assert(result, "contract is paused");
        });

        it("reverts joinGame when contract is paused", async () => {
            truffleAssert.reverts(bank.joinGame({from: player1}), "Pausable: paused");
        });

        it("reverts makeDeposit when contract is paused", async () => {
            truffleAssert.reverts(bank.makeDeposit({from: player1}), "Pausable: paused");
        });
    });

});
