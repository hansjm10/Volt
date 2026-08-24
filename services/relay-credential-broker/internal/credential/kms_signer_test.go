package credential

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"hash/crc32"
	"strings"
	"testing"
	"time"

	"cloud.google.com/go/kms/apiv1/kmspb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

const (
	testActiveKMSVersion   = "projects/volt-test/locations/us-central1/keyRings/relay/cryptoKeys/signing/cryptoKeyVersions/2"
	testRetiringKMSVersion = "projects/volt-test/locations/us-central1/keyRings/relay/cryptoKeys/signing/cryptoKeyVersions/1"
	testOtherKMSVersion    = "projects/volt-test/locations/us-central1/keyRings/relay/cryptoKeys/other/cryptoKeyVersions/1"
)

func TestKMSSignerIssuesWithActiveKeyAndVerifiesRetiringKey(t *testing.T) {
	activePublic, activePrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	retiringPublic, retiringPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	client := newFakeKMSClient(t, map[string]ed25519.PrivateKey{
		testActiveKMSVersion:   activePrivate,
		testRetiringKMSVersion: retiringPrivate,
	})
	signer, err := newKMSSignerWithClient(
		context.Background(),
		"https://credentials.volt.test",
		"volt-iroh-relay",
		testActiveKMSVersion,
		[]string{testRetiringKMSVersion},
		client,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer signer.Close()

	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	nodeID := strings.Repeat("a", 64)
	token, _, err := signer.Issue(
		context.Background(),
		nodeID,
		"host",
		"grant_identifier_one",
		"jwt_identifier_one",
		now,
		15*time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := signer.Verify(token, now); err != nil {
		t.Fatalf("active Cloud KMS token did not verify: %v", err)
	}
	if client.lastSignRequest == nil || client.lastSignRequest.Name != testActiveKMSVersion || client.lastSignRequest.Digest != nil {
		t.Fatalf("unexpected Cloud KMS signing request: %+v", client.lastSignRequest)
	}
	if client.lastSignRequest.DataCrc32C == nil || client.lastSignRequest.DataCrc32C.Value != int64(crc32.Checksum(client.lastSignRequest.Data, crc32cTable)) {
		t.Fatal("Cloud KMS signing request did not carry a valid data checksum")
	}

	retiringSigner, err := NewSigner("https://credentials.volt.test", "volt-iroh-relay", retiringPrivate)
	if err != nil {
		t.Fatal(err)
	}
	retiringToken, _, err := retiringSigner.Issue(
		context.Background(),
		nodeID,
		"host",
		"grant_identifier_one",
		"jwt_identifier_two",
		now,
		15*time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := signer.Verify(retiringToken, now); err != nil {
		t.Fatalf("retiring token did not verify during overlap: %v", err)
	}

	keyIDs := signer.KeyIDs()
	if len(keyIDs) != 2 || keyIDs[0] != keyIDFor(activePublic) || keyIDs[1] != keyIDFor(retiringPublic) {
		t.Fatalf("unexpected active/retiring key IDs: %v", keyIDs)
	}
	keys, ok := signer.JWKS()["keys"].([]map[string]string)
	if !ok || len(keys) != 2 || keys[0]["kid"] != keyIDs[0] || keys[1]["kid"] != keyIDs[1] {
		t.Fatalf("unexpected rotation JWKS: %+v", signer.JWKS())
	}
}

func TestKMSSignerRejectsInvalidPublicKeyMetadata(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(*kmspb.PublicKey)
	}{
		{
			name: "resource name",
			mutate: func(public *kmspb.PublicKey) {
				public.Name = testRetiringKMSVersion
			},
		},
		{
			name: "algorithm",
			mutate: func(public *kmspb.PublicKey) {
				public.Algorithm = kmspb.CryptoKeyVersion_EC_SIGN_P256_SHA256
			},
		},
		{
			name: "missing checksum",
			mutate: func(public *kmspb.PublicKey) {
				public.PemCrc32C = nil
			},
		},
		{
			name: "checksum",
			mutate: func(public *kmspb.PublicKey) {
				public.PemCrc32C.Value++
			},
		},
		{
			name: "PEM",
			mutate: func(public *kmspb.PublicKey) {
				public.Pem = "not a public key"
				public.PemCrc32C = wrapperspb.Int64(int64(crc32.Checksum([]byte(public.Pem), crc32cTable)))
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := newFakeKMSClient(t, map[string]ed25519.PrivateKey{testActiveKMSVersion: private})
			test.mutate(client.publicKeys[testActiveKMSVersion])
			if _, err := newKMSSignerWithClient(
				context.Background(),
				"https://credentials.volt.test",
				"volt-iroh-relay",
				testActiveKMSVersion,
				nil,
				client,
			); err == nil {
				t.Fatal("invalid Cloud KMS public key metadata was accepted")
			}
			if client.closeCalls != 1 {
				t.Fatalf("Cloud KMS close calls = %d, want 1", client.closeCalls)
			}
		})
	}
}

func TestKMSSignerRejectsInvalidSigningResponses(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, wrongPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(*kmspb.AsymmetricSignResponse, []byte)
	}{
		{
			name: "resource name",
			mutate: func(response *kmspb.AsymmetricSignResponse, _ []byte) {
				response.Name = testRetiringKMSVersion
			},
		},
		{
			name: "request checksum not verified",
			mutate: func(response *kmspb.AsymmetricSignResponse, _ []byte) {
				response.VerifiedDataCrc32C = false
			},
		},
		{
			name: "missing signature checksum",
			mutate: func(response *kmspb.AsymmetricSignResponse, _ []byte) {
				response.SignatureCrc32C = nil
			},
		},
		{
			name: "signature checksum",
			mutate: func(response *kmspb.AsymmetricSignResponse, _ []byte) {
				response.SignatureCrc32C.Value++
			},
		},
		{
			name: "wrong signature",
			mutate: func(response *kmspb.AsymmetricSignResponse, message []byte) {
				response.Signature = ed25519.Sign(wrongPrivate, message)
				response.SignatureCrc32C = wrapperspb.Int64(int64(crc32.Checksum(response.Signature, crc32cTable)))
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := newFakeKMSClient(t, map[string]ed25519.PrivateKey{testActiveKMSVersion: private})
			client.signResponseMutator = test.mutate
			if _, err := newKMSSignerWithClient(
				context.Background(),
				"https://credentials.volt.test",
				"volt-iroh-relay",
				testActiveKMSVersion,
				nil,
				client,
			); err == nil {
				t.Fatal("invalid Cloud KMS readiness signature was accepted")
			}
			if client.closeCalls != 1 {
				t.Fatalf("Cloud KMS close calls = %d, want 1", client.closeCalls)
			}
		})
	}
}

func TestKMSSignerRejectsUnsafeKeySets(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name     string
		active   string
		retiring []string
	}{
		{name: "malformed resource", active: "projects/volt-test/cryptoKeyVersions/1"},
		{name: "noncanonical version", active: strings.Replace(testActiveKMSVersion, "/2", "/02", 1)},
		{name: "duplicate resource", active: testActiveKMSVersion, retiring: []string{testActiveKMSVersion}},
		{name: "different CryptoKey", active: testActiveKMSVersion, retiring: []string{testOtherKMSVersion}},
		{name: "active older than retiring", active: testRetiringKMSVersion, retiring: []string{testActiveKMSVersion}},
		{name: "too many keys", active: testActiveKMSVersion, retiring: make([]string, maxVerificationKeys)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := newFakeKMSClient(t, map[string]ed25519.PrivateKey{testActiveKMSVersion: private})
			if _, err := newKMSSignerWithClient(
				context.Background(),
				"https://credentials.volt.test",
				"volt-iroh-relay",
				test.active,
				test.retiring,
				client,
			); err == nil {
				t.Fatal("unsafe Cloud KMS key set was accepted")
			}
			if client.closeCalls != 1 {
				t.Fatalf("Cloud KMS close calls = %d, want 1", client.closeCalls)
			}
		})
	}

	duplicateClient := newFakeKMSClient(t, map[string]ed25519.PrivateKey{
		testActiveKMSVersion:   private,
		testRetiringKMSVersion: private,
	})
	if _, err := newKMSSignerWithClient(
		context.Background(),
		"https://credentials.volt.test",
		"volt-iroh-relay",
		testActiveKMSVersion,
		[]string{testRetiringKMSVersion},
		duplicateClient,
	); err == nil {
		t.Fatal("duplicate public key under two Cloud KMS versions was accepted")
	}
}

type fakeKMSClient struct {
	publicKeys          map[string]*kmspb.PublicKey
	privateKeys         map[string]ed25519.PrivateKey
	lastSignRequest     *kmspb.AsymmetricSignRequest
	signResponseMutator func(*kmspb.AsymmetricSignResponse, []byte)
	closeCalls          int
}

func newFakeKMSClient(t *testing.T, privateKeys map[string]ed25519.PrivateKey) *fakeKMSClient {
	t.Helper()
	publicKeys := make(map[string]*kmspb.PublicKey, len(privateKeys))
	for name, private := range privateKeys {
		encoded, err := x509.MarshalPKIXPublicKey(private.Public().(ed25519.PublicKey))
		if err != nil {
			t.Fatal(err)
		}
		pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: encoded})
		publicKeys[name] = &kmspb.PublicKey{
			Pem:       string(pemBytes),
			Algorithm: kmspb.CryptoKeyVersion_EC_SIGN_ED25519,
			PemCrc32C: wrapperspb.Int64(int64(crc32.Checksum(pemBytes, crc32cTable))),
			Name:      name,
		}
	}
	return &fakeKMSClient{publicKeys: publicKeys, privateKeys: privateKeys}
}

func (c *fakeKMSClient) GetPublicKey(_ context.Context, name string) (*kmspb.PublicKey, error) {
	public := c.publicKeys[name]
	if public == nil {
		return nil, errors.New("public key not found")
	}
	return public, nil
}

func (c *fakeKMSClient) AsymmetricSign(
	_ context.Context,
	request *kmspb.AsymmetricSignRequest,
) (*kmspb.AsymmetricSignResponse, error) {
	private := c.privateKeys[request.Name]
	if private == nil {
		return nil, errors.New("signing key not found")
	}
	c.lastSignRequest = &kmspb.AsymmetricSignRequest{
		Name:       request.Name,
		Data:       append([]byte(nil), request.Data...),
		DataCrc32C: wrapperspb.Int64(request.DataCrc32C.Value),
	}
	signature := ed25519.Sign(private, request.Data)
	response := &kmspb.AsymmetricSignResponse{
		Signature:          signature,
		SignatureCrc32C:    wrapperspb.Int64(int64(crc32.Checksum(signature, crc32cTable))),
		VerifiedDataCrc32C: true,
		Name:               request.Name,
	}
	if c.signResponseMutator != nil {
		c.signResponseMutator(response, request.Data)
	}
	return response, nil
}

func (c *fakeKMSClient) Close() error {
	c.closeCalls++
	return nil
}
