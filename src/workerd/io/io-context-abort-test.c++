// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Tests of IoContext::abort() behavior.

#include <workerd/io/io-context.h>
#include <workerd/tests/test-fixture.h>

#include <kj/test.h>

namespace workerd {
namespace {

class LifecycleObserver final: public RequestObserver {
 public:
  void subrequestStarted(uint channel, bool inHouse,
      kj::Maybe<kj::StringPtr> invocationId,
      kj::Maybe<kj::StringPtr> traceId) override {
    started = true;
    startedChannel = channel;
    startedInHouse = inHouse;
    startedInvocationId = invocationId.map([](kj::StringPtr value) { return kj::str(value); });
    startedTraceId = traceId.map([](kj::StringPtr value) { return kj::str(value); });
  }

  void subrequestFinished(uint channel, bool inHouse, SubrequestOutcome outcome,
      kj::Maybe<kj::StringPtr> invocationId,
      kj::Maybe<kj::StringPtr> traceId) override {
    finished = true;
    ++finishedCount;
    finishedChannel = channel;
    finishedInHouse = inHouse;
    finishedOutcome = outcome;
    finishedInvocationId = invocationId.map([](kj::StringPtr value) { return kj::str(value); });
    finishedTraceId = traceId.map([](kj::StringPtr value) { return kj::str(value); });
  }

  bool started = false;
  uint startedChannel = 0;
  bool startedInHouse = false;
  kj::Maybe<kj::String> startedInvocationId;
  kj::Maybe<kj::String> startedTraceId;
  bool finished = false;
  uint finishedCount = 0;
  uint finishedChannel = 0;
  bool finishedInHouse = false;
  SubrequestOutcome finishedOutcome = SubrequestOutcome::COMPLETED;
  kj::Maybe<kj::String> finishedInvocationId;
  kj::Maybe<kj::String> finishedTraceId;
};

class LifecycleFactory final: public TestFixture::DummyIoChannelFactory {
 public:
  LifecycleFactory(TimerChannel& timer): DummyIoChannelFactory(timer) {}

  kj::Own<WorkerInterface> startSubrequest(uint, SubrequestMetadata metadata) override {
    deadline = metadata.deadline;
    class FailingWorker final: public WorkerInterface {
     public:
      FailingWorker(bool disconnected): disconnected(disconnected) {}

      kj::Promise<void> request(kj::HttpMethod, kj::StringPtr, const kj::HttpHeaders&,
          kj::AsyncInputStream&, kj::HttpService::Response&) override {
        return disconnected ? kj::Promise<void>(KJ_EXCEPTION(DISCONNECTED, "lifecycle test canceled"))
                             : kj::Promise<void>(KJ_EXCEPTION(FAILED, "lifecycle test failure"));
      }
      kj::Promise<void> connect(kj::StringPtr, const kj::HttpHeaders&, kj::AsyncIoStream&,
          kj::HttpService::ConnectResponse&, kj::HttpConnectSettings) override {
        return disconnected ? kj::Promise<void>(KJ_EXCEPTION(DISCONNECTED, "lifecycle test canceled"))
                             : kj::Promise<void>(KJ_EXCEPTION(FAILED, "lifecycle test failure"));
      }
      kj::Promise<void> prewarm(kj::StringPtr) override { return kj::READY_NOW; }
      kj::Promise<ScheduledResult> runScheduled(kj::Date, kj::StringPtr) override {
        return KJ_EXCEPTION(FAILED, "unsupported");
      }
      kj::Promise<AlarmResult> runAlarm(kj::Date, uint32_t) override {
        return KJ_EXCEPTION(FAILED, "unsupported");
      }
      kj::Promise<CustomEvent::Result> customEvent(kj::Own<CustomEvent>) override {
        return KJ_EXCEPTION(FAILED, "unsupported");
      }

     private:
      bool disconnected;
    };
    return kj::heap<FailingWorker>(calls++ != 0);
  }

 private:
  uint calls = 0;
 public:
  kj::Maybe<kj::Date> deadline;
};

class LifecycleResponse final: public kj::HttpService::Response {
 public:
  kj::Own<kj::AsyncOutputStream> send(uint, kj::StringPtr, const kj::HttpHeaders&,
      kj::Maybe<uint64_t> = kj::none) override {
    KJ_FAIL_ASSERT("lifecycle test response was unexpectedly sent");
  }

  kj::Own<kj::WebSocket> acceptWebSocket(const kj::HttpHeaders&) override {
    KJ_FAIL_ASSERT("lifecycle test websocket was unexpectedly accepted");
  }
};

KJ_TEST("subrequest lifecycle reports correlation and failure") {
  LifecycleObserver* observer = nullptr;
  TestFixture fixture(TestFixture::SetupParams{
    .ioChannelFactory = kj::Function<kj::Rc<IoChannelFactory>(TimerChannel&)>(
        [](TimerChannel& timer) -> kj::Rc<IoChannelFactory> {
    return kj::rc<LifecycleFactory>(timer);
  }),
    .requestObserverFactory = kj::Function<kj::Own<RequestObserver>()>(
        [&observer]() -> kj::Own<RequestObserver> {
    auto result = kj::refcounted<LifecycleObserver>();
    observer = result.get();
    return kj::mv(result);
  }),
  });
  auto request = fixture.newIncomingRequest();
  auto client = request->getContext().getSubrequestChannel(7, false, kj::none, "test"_kjc);
  kj::HttpHeaderTable headerTable;
  kj::HttpHeaders headers(headerTable);
  kj::NullStream body;
  LifecycleResponse response;

  KJ_EXPECT_THROW_MESSAGE("lifecycle test failure",
      client->request(kj::HttpMethod::GET, "https://example.com", headers, body, response)
          .wait(fixture.getWaitScope()));
  KJ_ASSERT_NONNULL(observer);
  KJ_EXPECT(observer->started);
  KJ_EXPECT(observer->finished);
  KJ_EXPECT(observer->startedChannel == 7);
  KJ_EXPECT(observer->finishedChannel == 7);
  KJ_EXPECT(observer->finishedOutcome == SubrequestOutcome::FAILED);
  KJ_EXPECT(observer->startedInvocationId != kj::none);
  KJ_EXPECT(observer->startedTraceId != kj::none);
  KJ_EXPECT(observer->finishedInvocationId != kj::none);
  KJ_EXPECT(observer->finishedTraceId != kj::none);

  auto canceledClient = request->getContext().getSubrequestChannel(8, false, kj::none, "cancel"_kjc);
  KJ_EXPECT_THROW_MESSAGE("lifecycle test canceled",
      canceledClient->request(kj::HttpMethod::GET, "https://example.com", headers, body, response)
          .wait(fixture.getWaitScope()));
  KJ_EXPECT(observer->finishedCount == 2);
  KJ_EXPECT(observer->finishedOutcome == SubrequestOutcome::CANCELED);
  fixture.drainAndDestroy(kj::mv(request));
}

KJ_TEST("subrequest metadata carries the invocation deadline") {
  LifecycleFactory* factory = nullptr;
  auto expected = kj::UNIX_EPOCH + 123 * kj::SECONDS;
  TestFixture fixture(TestFixture::SetupParams{
    .ioChannelFactory = kj::Function<kj::Rc<IoChannelFactory>(TimerChannel&)>(
        [&factory](TimerChannel& timer) -> kj::Rc<IoChannelFactory> {
    auto result = kj::rc<LifecycleFactory>(timer);
    factory = result.get();
    return result;
  }),
    .invocationDeadline = expected,
  });
  auto request = fixture.newIncomingRequest();
  auto client = request->getContext().getSubrequestChannel(9, false, kj::none, "deadline"_kjc);
  kj::HttpHeaderTable headerTable;
  kj::HttpHeaders headers(headerTable);
  kj::NullStream body;
  LifecycleResponse response;
  KJ_EXPECT_THROW_MESSAGE("lifecycle test failure",
      client->request(kj::HttpMethod::GET, "https://example.com", headers, body, response)
          .wait(fixture.getWaitScope()));
  KJ_ASSERT_NONNULL(factory);
  KJ_IF_SOME(deadline, factory->deadline) {
    KJ_EXPECT(deadline == expected);
  } else {
    KJ_FAIL_ASSERT("deadline metadata was absent");
  }
  fixture.drainAndDestroy(kj::mv(request));
}

KJ_TEST("JS queued before abort() does not run after it") {
  TestFixture fixture;
  auto request = fixture.newIncomingRequest();
  auto& context = request->getContext();
  auto& waitScope = fixture.getWaitScope();

  bool firstRan = false;
  bool secondRan = false;

  // Simulate outstanding I/O, as in a real request that has pending subrequests, streams, etc.
  // (e.g. awaitIo() attaches a pending event to every promise it awaits). Without this, the
  // registerPendingEvent() call in runImpl() happens to throw the abort exception as a side
  // effect of hang detection, masking the gap this test covers. With an existing PendingEvent
  // alive -- or in an actor context, which doesn't use pending events at all -- it performs no
  // abort check.
  auto pendingEvent = context.registerPendingEvent();

  // Make two back-to-back calls to run(). Both pass the abort check at the top of runSingle()
  // before either has acquired the isolate lock and entered JS. The first run aborts the context,
  // so the second must be refused rather than executed.
  auto first = context.run([&firstRan](Worker::Lock&, IoContext& context) {
    firstRan = true;
    context.abort(KJ_EXCEPTION(FAILED, "jsg.Error: test abort reason"));
  });
  auto second = context.run([&secondRan](Worker::Lock&) { secondRan = true; });

  first.wait(waitScope);
  KJ_EXPECT(firstRan);

  KJ_EXPECT_THROW_MESSAGE("test abort reason", second.wait(waitScope));
  KJ_EXPECT(!secondRan);

  fixture.drainAndDestroy(kj::mv(request));
}

}  // namespace
}  // namespace workerd
